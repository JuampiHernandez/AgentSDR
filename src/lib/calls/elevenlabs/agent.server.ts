import "server-only";

import { getPlatformCredentials } from "@/lib/platform/credentials";
import { getPromptTemplate } from "@/lib/observability/langfuse";
import { traceGeneration } from "@/lib/observability/langfuse";
import { fillPrompt } from "@/lib/prompts/template";
import { currentOrganizationId } from "@/lib/tenancy/scope";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { inOrg } from "@/lib/tenancy/scope";
import { AGENT_OUTCOMES, DEFAULT_AGENT_NAME, type AgentTokenRequest, type AgentTokenResponse, type ElevenLabsCallSession } from "../contract";
import { loadAgentContext, loadCampaignKnowledgeIds } from "../agentContext";
import { agentInstructions, agentKnowledge, callNotes, resolveLiveSetupTemplates, saveHeardAudio } from "../liveAgent";
import { callCampaignContacts, callCampaigns, type callSessions } from "../schema";
import type { Rehearsal } from "../rehearsal";
import { CallApiError } from "../sessions";
import {
  DEFAULT_ELEVENLABS_VOICE,
  ELEVENLABS_MODES,
  type ElevenLabsMode,
  type ElevenLabsSessionResponse,
  type ElevenLabsVoice,
} from "./contract";

/**
 * ElevenLabs' phone agent (ElevenLabs Agents) as a second voice engine.
 *
 * Nothing is set up by hand in ElevenLabs: AgentSDR keeps one agent per
 * organization and mode in the connected account — found by name, created
 * when missing and patched to the configuration below once per process —
 * with the call's three tools as client tools. The agent itself carries only
 * a placeholder prompt: every conversation brings the call's real system
 * prompt (agentInstructions, the same text a Gemini call gets), its opening
 * line and the voice as overrides, which the agent is configured to accept.
 *
 * Measured 17 Nov 2026 with Nisha's real prompt and recorded replies: the
 * realtime mode replied a median 0.66 s after the lead's last sound (Gemini
 * Live: 1.2 s over 193 replies), but always in English; the standard mode
 * (Scribe → Gemini 3.5 Flash-Lite → Flash v2.5 voices) switches to Hinglish,
 * at about 1–2.5 s.
 */

const API = "https://api.elevenlabs.io";
const SYNC_TTL_MS = 10 * 60 * 1000;
/** Placeholder: each conversation overrides it with the call's own system prompt. */
const PLACEHOLDER_PROMPT = "You are an AI calling agent. Your instructions for each call arrive when the call starts.";
const STANDARD_LLM = "gemini-3.5-flash-lite";
const TOOL_NAMES = ["record_outcome", "wait_for_them", "end_call"] as const;

type Credentials = { apiKey: string };

async function credentials(): Promise<Credentials> {
  const stored = await getPlatformCredentials("elevenlabs");
  if (!stored?.apiKey) throw new CallApiError(409, "Connect ElevenLabs in Settings → AI provider first");
  return { apiKey: stored.apiKey };
}

async function api<T>(key: Credentials, method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: { "xi-api-key": key.apiKey, "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
  } catch {
    throw new CallApiError(424, "Could not reach ElevenLabs");
  }
  const text = await response.text();
  if (response.status === 401) throw new CallApiError(424, "ElevenLabs rejected the saved API key");
  if (!response.ok) {
    let reason = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { detail?: { message?: string } | string };
      reason = typeof parsed.detail === "string" ? parsed.detail : (parsed.detail?.message ?? reason);
    } catch {}
    // Not 502: Cloudflare replaces a 502's body, and the page should show ElevenLabs' reason.
    throw new CallApiError(424, `ElevenLabs refused (${response.status}): ${reason}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

/** The call's tools, as ElevenLabs client tools: the same names and descriptions a Gemini call gets. */
async function toolConfigs() {
  const { templates } = await resolveLiveSetupTemplates();
  return [
    {
      type: "client",
      name: "record_outcome",
      description: fillPrompt(templates["calls/tool-record-outcome"], {}),
      expects_response: true,
      parameters: {
        type: "object",
        properties: {
          outcome: { type: "string", enum: [...AGENT_OUTCOMES], description: fillPrompt(templates["calls/tool-record-outcome-kinds"], {}) },
          summary: { type: "string", description: "One sentence on what happened and anything they asked for." },
          when: { type: "string", description: "For meeting_booked, human_callback or call_back: the day and time as agreed, in their words (\"Thursday around 4 pm\")." },
          whenAt: { type: "string", description: "The exact instant of an agreed meeting or call-back time, ISO 8601 with UTC offset, worked out from the current date and time in your instructions. Omit if no time was agreed." },
        },
        required: ["outcome", "summary"],
      },
    },
    { type: "client", name: "wait_for_them", description: fillPrompt(templates["calls/tool-wait-for-them"], {}), expects_response: true, parameters: { type: "object", properties: {} } },
    {
      type: "client",
      name: "end_call",
      description: fillPrompt(templates["calls/tool-end-call"], {}),
      expects_response: true,
      parameters: { type: "object", properties: { reason: { type: "string", description: "Why the call is ending, in a few words." } } },
    },
  ];
}

/** The account's client tools by name, created when missing. Tools are per account, shared by its agents. */
async function ensureTools(key: Credentials): Promise<string[]> {
  const listed = await api<{ tools?: { id: string; tool_config?: { name?: string; type?: string } }[] }>(key, "GET", "/v1/convai/tools");
  const configs = await toolConfigs();
  const ids: string[] = [];
  for (const name of TOOL_NAMES) {
    const existing = listed.tools?.find((tool) => tool.tool_config?.type === "client" && tool.tool_config?.name === name);
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const created = await api<{ id: string }>(key, "POST", "/v1/convai/tools", { tool_config: configs.find((config) => config.name === name) });
    ids.push(created.id);
  }
  return ids;
}

function agentName(mode: ElevenLabsMode): string {
  return `AgentSDR · ${mode === "realtime" ? "Realtime" : "Standard"} · ${currentOrganizationId().slice(0, 8)}`;
}

function agentConfig(mode: ElevenLabsMode, toolIds: string[]) {
  // Hindi only where it can be spoken: the realtime model answered Hindi in
  // English, and with Hindi detection on it heard English as Hindi ("Sure" as
  // "चार") and replied slower (median 1.1 s instead of 0.66 s; 17 Nov 2026).
  const hindi = mode === "standard";
  return {
    name: agentName(mode),
    tags: ["agentsdr"],
    conversation_config: {
      agent: {
        first_message: "",
        language: "en",
        // Standard: Hindi or Hinglish from the lead switches the agent to Hindi (language_detection), spoken as Hinglish.
        hinglish_mode: hindi,
        prompt: {
          prompt: PLACEHOLDER_PROMPT,
          llm: STANDARD_LLM,
          temperature: 0.6,
          tool_ids: toolIds,
          built_in_tools: {
            language_detection: hindi ? { type: "system", name: "language_detection", description: "", params: { system_tool_type: "language_detection" } } : null,
          },
        },
      },
      // An English agent must use an English-only voice model; the Hindi preset brings a multilingual one.
      language_presets: hindi ? { hi: { overrides: { agent: { language: "hi" }, tts: { model_id: "eleven_flash_v2_5" } } } } : {},
      tts: { model_id: "eleven_flash_v2", voice_id: DEFAULT_ELEVENLABS_VOICE, agent_output_audio_format: "pcm_16000" },
      asr: { provider: "scribe_realtime", user_input_audio_format: "pcm_16000", keywords: ["Kandid"] },
      turn: { turn_eagerness: "normal" },
      conversation: {
        max_duration_seconds: 900,
        client_events: ["conversation_initiation_metadata", "audio", "user_transcript", "agent_response", "interruption", "ping", "client_tool_call", "agent_response_correction"],
      },
      realtime_model: mode === "realtime" ? "eleven_realtime_v1_mini" : null,
    },
    platform_settings: {
      overrides: {
        conversation_config_override: {
          agent: { first_message: true, language: true, prompt: { prompt: true } },
          tts: { voice_id: true },
        },
      },
    },
  };
}

const synced = new Map<string, { agentId: string; at: number }>();

/** The organization's agent for `mode`, created or brought up to date (at most every 10 minutes per process). */
export async function ensureElevenLabsAgent(mode: ElevenLabsMode): Promise<string> {
  const key = await credentials();
  const cacheKey = `${currentOrganizationId()}|${mode}`;
  const cached = synced.get(cacheKey);
  if (cached && Date.now() - cached.at < SYNC_TTL_MS) return cached.agentId;
  const name = agentName(mode);
  const toolIds = await ensureTools(key);
  const config = agentConfig(mode, toolIds);
  const found = await api<{ agents?: { agent_id: string; name: string }[] }>(key, "GET", `/v1/convai/agents?search=${encodeURIComponent(name)}&page_size=20`);
  const existing = found.agents?.find((agent) => agent.name === name);
  let agentId: string;
  if (existing) {
    await api(key, "PATCH", `/v1/convai/agents/${existing.agent_id}`, config);
    agentId = existing.agent_id;
  } else {
    agentId = (await api<{ agent_id: string }>(key, "POST", "/v1/convai/agents/create", config)).agent_id;
  }
  synced.set(cacheKey, { agentId, at: Date.now() });
  return agentId;
}

/** A signed conversation for the organization's `mode` agent, with the overrides that make it this call. */
async function conversation(system: string, firstMessage: string, mode: ElevenLabsMode, voice: string): Promise<ElevenLabsCallSession> {
  const key = await credentials();
  const agentId = await ensureElevenLabsAgent(mode);
  const { signed_url: signedUrl } = await api<{ signed_url: string }>(key, "GET", `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`);
  return { signedUrl, override: { agent: { prompt: { prompt: system }, first_message: firstMessage, language: "en" }, tts: { voice_id: voice } } };
}

const warmed = new Map<string, number>();
const WARM_FOR_MS = 6 * 60 * 60 * 1000;
/** When this process started warming each voice: until READY_AFTER_MS later, its calls use the default voice. */
const warmingSince = new Map<string, number>();
/** Tia, warmed at 10:33:26, was the default voice on a call 18 s later and right 3 minutes later (18 Nov 2026). */
const READY_AFTER_MS = 3 * 60 * 1000;

/**
 * The voice a call speaks with: the campaign's, unless this process began
 * preparing it under READY_AFTER_MS ago — then the default voice, which is
 * always ready, rather than ElevenLabs' fallback (heard as a man).
 */
export function voiceForCall(voiceId: string | null): { voice: string; stillPreparing: string | null } {
  const voice = voiceId?.trim() || DEFAULT_ELEVENLABS_VOICE;
  if (voice === DEFAULT_ELEVENLABS_VOICE) return { voice, stillPreparing: null };
  const since = warmingSince.get(`${currentOrganizationId()}|${voice}`);
  return since !== undefined && Date.now() - since < READY_AFTER_MS ? { voice: DEFAULT_ELEVENLABS_VOICE, stillPreparing: voice } : { voice, stillPreparing: null };
}

/**
 * Gets a voice ready for the realtime agent before its first call. The first
 * time the realtime mode speaks with a voice, ElevenLabs answers in a default
 * voice (about 170 Hz, heard as a man) and prepares the chosen one; minutes
 * later the voice is right (Neha and Raju: 170 Hz on first use, 242 Hz and
 * 140 Hz ten minutes later — 18 Nov 2026). So a campaign that picks a voice
 * speaks with it once, right away, in a throwaway conversation. Never throws.
 */
export async function warmElevenLabsVoice(voiceId: string | null): Promise<void> {
  const voice = voiceId?.trim() || DEFAULT_ELEVENLABS_VOICE;
  const key = `${currentOrganizationId()}|${voice}`;
  if (Date.now() - (warmed.get(key) ?? 0) < WARM_FOR_MS) return;
  if (voice !== DEFAULT_ELEVENLABS_VOICE) warmingSince.set(key, Date.now());
  try {
    const session = await conversation("Say the line you are given, and nothing else.", "Hello, this is a quick voice check.", "realtime", voice);
    await new Promise<void>((resolve) => {
      const socket = new WebSocket(session.signedUrl);
      const done = () => {
        clearTimeout(timer);
        try {
          socket.close();
        } catch {}
        resolve();
      };
      const timer = setTimeout(done, 15_000);
      socket.onopen = () => socket.send(JSON.stringify({ type: "conversation_initiation_client_data", conversation_config_override: session.override }));
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as { type?: string; ping_event?: { event_id: number } };
        if (message.type === "ping" && message.ping_event) socket.send(JSON.stringify({ type: "pong", event_id: message.ping_event.event_id }));
        if (message.type === "agent_response") setTimeout(done, 3_000);
      };
      socket.onerror = done;
      socket.onclose = done;
    });
    warmed.set(key, Date.now());
  } catch (error) {
    console.warn("[elevenlabs] could not warm voice", voice, error instanceof Error ? error.message : error);
  }
}

/** Who talks on a call: its AI campaign's voice engine (Gemini when it has none, e.g. a call placed by hand). */
export async function callVoiceEngine(campaignContactId: string | null): Promise<{ engine: "gemini" | "elevenlabs"; voice: string | null }> {
  if (!campaignContactId) return { engine: "gemini", voice: null };
  const [row] = await db
    .select({ engine: callCampaigns.aiVoiceEngine, voice: callCampaigns.aiElevenlabsVoice })
    .from(callCampaignContacts)
    .innerJoin(callCampaigns, eq(callCampaigns.id, callCampaignContacts.campaignId))
    .where(and(inOrg(callCampaigns), eq(callCampaignContacts.id, campaignContactId)))
    .limit(1);
  return row ? { engine: row.engine, voice: row.voice } : { engine: "gemini", voice: null };
}

/**
 * The agent session of a real call whose campaign talks through ElevenLabs:
 * the same system prompt mintAgentToken builds for Gemini (the campaign's
 * knowledge, the lead's history, the time, the calling instructions), in
 * ElevenLabs' realtime mode. On a call-back the agent answers first, as a
 * person picking up would: with no opening line it said nothing, the caller
 * waited for it, and it asked "Hello? Are you still there?" 10 s in
 * (Hemang, 19 Nov 2026).
 */
export async function mintElevenLabsCallToken(
  row: typeof callSessions.$inferSelect,
  request: AgentTokenRequest,
  voice: string | null,
): Promise<AgentTokenResponse> {
  if (row.remoteRep) throw new CallApiError(409, "A rep talks on this call, not the AI agent");
  if (row.status !== "pending" && row.status !== "in_progress") throw new CallApiError(409, "This call is already over");
  const inbound = row.direction === "inbound";
  const [knowledge, context, live, notes, firstMessage] = await Promise.all([
    loadCampaignKnowledgeIds(row.campaignContactId).then((ids) => agentKnowledge(ids)),
    loadAgentContext(row),
    resolveLiveSetupTemplates(),
    callNotes(),
    getPromptTemplate(inbound ? "calls/elevenlabs-callback-first-message" : "calls/elevenlabs-first-message"),
  ]);
  const system = agentInstructions(request, knowledge, context, live.templates["calls/agent-system"], "elevenlabs");
  const firstName = request.lead?.firstName?.trim() ?? "";
  const opening = inbound
    ? fillPrompt(firstMessage.text, { first_name: firstName || null, agent_name: request.name ?? DEFAULT_AGENT_NAME })
    : firstName
      ? fillPrompt(firstMessage.text, { first_name: firstName })
      : "";
  const { voice: voiceId, stillPreparing } = voiceForCall(voice);
  const session = await traceGeneration(
    {
      name: "call-agent-setup",
      model: "elevenlabs-realtime",
      input: { system, voice: voiceId, opening, ...(stillPreparing ? { voiceStillPreparing: stillPreparing } : {}) },
      prompts: [...live.prompts, ...notes.prompts, firstMessage],
      sessionId: row.id,
      metadata: { engine: "elevenlabs", callId: row.id, personId: row.personId, campaignContactId: row.campaignContactId, direction: row.direction, knowledge: knowledge.map((document) => document.title) },
    },
    async (record) => {
      const made = await conversation(system, opening, "realtime", voiceId);
      record({ output: { engine: "elevenlabs", voice: voiceId } });
      return made;
    },
  );
  return { token: "", model: "elevenlabs-realtime", websocketUrl: "", saveHeardAudio: saveHeardAudio(), notes: notes.notes, elevenlabs: session };
}

/**
 * A rehearsal conversation: a signed URL for the organization's agent and
 * the overrides that make it this campaign's call — the system prompt a
 * Gemini call would get, the opening line and the voice. The browser sends
 * the overrides as the conversation starts; the API key stays here.
 */
export async function elevenLabsRehearsalSession(rehearsal: Rehearsal, mode: ElevenLabsMode, voiceId: string | null): Promise<ElevenLabsSessionResponse> {
  if (!ELEVENLABS_MODES.includes(mode)) throw new CallApiError(400, "mode must be realtime or standard");
  const key = await credentials();
  const [{ templates, prompts }, firstMessage] = await Promise.all([resolveLiveSetupTemplates(), getPromptTemplate("calls/elevenlabs-first-message")]);
  const system = agentInstructions(rehearsal.request, rehearsal.knowledge, rehearsal.context, templates["calls/agent-system"], "elevenlabs");
  const firstName = rehearsal.request.lead?.firstName?.trim() ?? "";
  const { voice } = voiceForCall(voiceId);
  return traceGeneration(
    {
      name: "call-voice-rehearsal-setup",
      model: `elevenlabs-${mode}`,
      input: { system, voice, mode },
      prompts: [...prompts, firstMessage],
      metadata: { engine: "elevenlabs", knowledge: rehearsal.knowledge.map((document) => document.title) },
    },
    async (record) => {
      const made = await conversation(system, firstName ? fillPrompt(firstMessage.text, { first_name: firstName }) : "", mode, voice);
      record({ output: { mode } });
      return { ...made, mode, voiceId: voice };
    },
  );
}

type SharedVoice = { voice_id: string; name: string; gender?: string; age?: string; descriptive?: string; preview_url?: string; language?: string; accent?: string };
const voiceCache = new Map<string, { at: number; voices: ElevenLabsVoice[] }>();

/**
 * Conversational English voices from ElevenLabs' library for the pickers:
 * Indian-English first (the leads are in India), then the most used of other
 * accents, each with its accent so the picker can show a flag. Cached an hour.
 */
export async function listElevenLabsVoices(): Promise<ElevenLabsVoice[]> {
  const key = await credentials();
  const cacheKey = currentOrganizationId();
  const cached = voiceCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.voices;
  const list = (extra: Record<string, string>) =>
    api<{ voices?: SharedVoice[] }>(key, "GET", `/v1/shared-voices?${new URLSearchParams({ language: "en", use_cases: "conversational", sort: "usage_character_count_1y", ...extra })}`);
  const [indian, others] = await Promise.all([list({ accent: "indian", page_size: "24" }), list({ page_size: "40" })]);
  const seen = new Set<string>();
  const voices = [...(indian.voices ?? []), ...(others.voices ?? []).filter((voice) => voice.accent?.toLowerCase() !== "indian").slice(0, 16)]
    .filter((voice) => !seen.has(voice.voice_id) && seen.add(voice.voice_id))
    .map((voice) => ({
      id: voice.voice_id,
      name: voice.name,
      detail: [voice.gender, voice.age?.replace("_", " "), voice.descriptive].filter(Boolean).join(" · "),
      previewUrl: voice.preview_url ?? null,
      accent: voice.accent ?? null,
    }));
  voiceCache.set(cacheKey, { at: Date.now(), voices });
  return voices;
}
