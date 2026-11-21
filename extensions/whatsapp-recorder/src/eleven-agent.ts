/**
 * The AI voice agent through ElevenLabs' phone agent (ElevenLabs Agents,
 * realtime mode), for a campaign whose voice engine is ElevenLabs. The same
 * shape as LiveAgent (Gemini Live), so wa-agent drives either one the same way
 * (agent-session.ts picks): the lead's side goes in as 16 kHz PCM, the agent's
 * voice comes out as 16 kHz PCM to wa-hook, and its tools are the call's
 * (record_outcome, wait_for_them, end_call), declared on the agent that
 * AgentSDR keeps in the organization's ElevenLabs account.
 *
 * The opening line (first_message) is spoken as soon as the conversation
 * starts, which is while the call rings: it is held until the lead picks up
 * and has said hello, as LiveAgent holds Gemini's prepared greeting. While it
 * is held the lead's audio goes in as silence, so their "Hello?" does not
 * make the agent greet a second time. A call-back has its own opening line
 * (the caller waits for whoever picks up to speak first), made while it
 * rings and played as soon as Accept is pressed.
 *
 * Measured on rehearsals (17 Nov 2026): replies start ~0.7–0.8 s after the
 * lead's last sound, against Gemini Live's ~1.2 s on calls.
 *
 * Audio is played the way ElevenLabs' own client plays it: an interruption
 * carries an event id, and audio of an earlier reply that still arrives after
 * it is dropped, not played over the lead. And once the agent has said goodbye
 * and called end_call, a reply it makes after that is never played: the model
 * answered the tool results with "[Call note: logged as wrong_person …]",
 * spoken aloud on three calls (18–20 Nov 2026).
 */
import type { AgentTokenResponse, ElevenLabsCallSession } from "../../../src/lib/calls/contract";
import { GREETING_WAIT_MS, HELLO_MAX_WAIT_MS, HELLO_PAUSE_MS, MAX_HEARD_SAMPLES, VOICE_PEAK, fromBase64, toBase64, type AgentHandlers } from "./live-agent";

const RATE = 16_000;
/** After end_call, hang up this long after the agent's last audio would have finished playing. */
const HANGUP_AFTER_AUDIO_MS = 800;
/** end_call with no goodbye spoken after it: hang up anyway. */
const HANGUP_MAX_WAIT_MS = 6_000;

type ServerEvent =
  | { type: "conversation_initiation_metadata"; conversation_initiation_metadata_event?: { conversation_id?: string } }
  | { type: "audio"; audio_event: { audio_base_64: string; event_id?: number } }
  | { type: "user_transcript"; user_transcription_event: { user_transcript: string } }
  | { type: "agent_response"; agent_response_event: { agent_response: string } }
  | { type: "agent_response_correction"; agent_response_correction_event: { corrected_agent_response: string } }
  | { type: "interruption"; interruption_event?: { event_id?: number } }
  | { type: "ping"; ping_event: { event_id: number } }
  | { type: "client_tool_call"; client_tool_call: { tool_name: string; tool_call_id: string; parameters?: Record<string, unknown> } };

export class ElevenAgent {
  private socket: WebSocket | null = null;
  private ready = false;
  private closed = false;
  private readonly expectsOpening: boolean;
  /** The opening line, held until the pick-up and their hello. */
  private holding: boolean;
  private held: ArrayBuffer[] = [];
  private pickedUp = false;
  private pickedUpAt = 0;
  private helloWatch: ReturnType<typeof setInterval> | null = null;
  private lastVoiceAt = 0;
  private replying = false;
  private firstAudio = true;
  private warnedNotReady = false;
  /** When the agent's audio sent so far would finish playing (ms since epoch). */
  private playsUntil = 0;
  private hangup: { reason: string; timer: ReturnType<typeof setTimeout> | null; maxTimer: ReturnType<typeof setTimeout> } | null = null;
  private heard: Int16Array[] | null = null;
  private heardSamples = 0;
  /** Audio of replies before this event id was cut off by the lead: dropped. */
  private interruptedBefore = 0;
  /** The reply being played (its event id), and whether it began after the lead's last words. */
  private replyEventId = -1;
  private replyAfterLead = false;
  /** Whether the reply being played has had its text (agent_response) yet. */
  private replyTextSeen = false;
  /** After the goodbye and end_call: replies after this event id are not played. */
  private quietAfter: number | null = null;
  private keptQuiet = false;

  constructor(
    private readonly handlers: AgentHandlers,
    private readonly token: AgentTokenResponse & { elevenlabs: ElevenLabsCallSession },
  ) {
    this.expectsOpening = token.elevenlabs.override.agent.first_message.trim() !== "";
    this.holding = this.expectsOpening;
  }

  start(): void {
    if (this.closed) return;
    if (this.token.saveHeardAudio) {
      this.heard = [];
      this.handlers.trace("AI agent: saving what it hears (test option)");
    }
    const socket = new WebSocket(this.token.elevenlabs.signedUrl);
    this.socket = socket;
    socket.onopen = () => this.send({ type: "conversation_initiation_client_data", conversation_config_override: this.token.elevenlabs.override });
    socket.onmessage = (event) => this.receive(String(event.data));
    socket.onerror = () => console.warn("[agentsdr agent] ElevenLabs socket error");
    socket.onclose = (event) => {
      this.ready = false;
      if (!this.closed) this.handlers.trace(`AI agent: disconnected (${event.code}${event.reason ? ` ${event.reason}` : ""})`);
    };
  }

  /** The opening line is always made as the conversation starts; nothing more to do. */
  prepareGreeting(): void {}

  /** True once the opening line's first audio is held (or, with no opening line, once the session is ready). */
  greetingHeld(maxMs: number): Promise<boolean> {
    const until = Date.now() + maxMs;
    return new Promise((resolve) => {
      const check = () => {
        if (this.held.length || (!this.expectsOpening && this.ready)) return resolve(true);
        if (this.closed || Date.now() >= until) return resolve(false);
        setTimeout(check, 50);
      };
      check();
    });
  }

  /** The lead picked up: the opening plays once they have said hello (or after a short wait). */
  greet(): void {
    this.pickedUp = true;
    this.pickedUpAt = Date.now();
    if (!this.holding) {
      this.handlers.trace("AI agent: lead picked up — waiting for their hello");
      return;
    }
    this.handlers.trace("AI agent: picked up — greeting ready, waiting for their hello");
    this.helloWatch = setInterval(() => {
      const now = Date.now();
      const spoke = this.lastVoiceAt > this.pickedUpAt;
      if (spoke && now - this.lastVoiceAt >= HELLO_PAUSE_MS) this.release("after their hello");
      else if (!spoke && now - this.pickedUpAt >= GREETING_WAIT_MS) this.release("they said nothing");
      else if (now - this.pickedUpAt >= HELLO_MAX_WAIT_MS) this.release("the line never went quiet");
    }, 50);
  }

  /** The lead's side of the call: mono 16-bit PCM at 16 kHz. */
  sendAudio(pcm: ArrayBuffer): void {
    const samples = new Int16Array(pcm);
    let peak = 0;
    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]!));
    if (peak > VOICE_PEAK && this.pickedUp) {
      this.lastVoiceAt = Date.now();
      this.replying = false;
    }
    if (!this.ready || !this.socket) {
      if (!this.warnedNotReady) this.handlers.trace("AI agent: lead audio arrived before the session was ready — dropped");
      this.warnedNotReady = true;
      return;
    }
    // While the opening is held, their hello stays out of the conversation.
    this.send({ user_audio_chunk: toBase64(this.holding ? new ArrayBuffer(pcm.byteLength) : pcm) });
    if (this.heard && !this.holding && this.heardSamples < MAX_HEARD_SAMPLES) {
      const copy = new Int16Array(pcm.slice(0));
      this.heard.push(copy);
      this.heardSamples += copy.length;
    }
  }

  takeHeardAudio(): Int16Array | null {
    if (!this.heard?.length) return null;
    const all = new Int16Array(this.heardSamples);
    let at = 0;
    for (const chunk of this.heard) {
      all.set(chunk, at);
      at += chunk.length;
    }
    this.heard = null;
    this.heardSamples = 0;
    return all;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    if (this.helloWatch) clearInterval(this.helloWatch);
    if (this.hangup) {
      if (this.hangup.timer) clearTimeout(this.hangup.timer);
      clearTimeout(this.hangup.maxTimer);
    }
    try {
      this.socket?.close(1000);
    } catch {
      // Already closing.
    }
    this.socket = null;
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private release(why: string): void {
    if (this.helloWatch) clearInterval(this.helloWatch);
    this.helloWatch = null;
    if (!this.holding) return;
    this.holding = false;
    const held = this.held.splice(0);
    this.handlers.trace(`AI agent: greeting ${Date.now() - this.pickedUpAt} ms after the pick-up, ${why} (${held.length ? "prepared before the pick-up" : "still being prepared"})`);
    for (const pcm of held) this.play(pcm);
  }

  private play(pcm: ArrayBuffer): void {
    const now = Date.now();
    this.playsUntil = Math.max(now, this.playsUntil) + (pcm.byteLength / 2 / RATE) * 1000;
    this.handlers.play(pcm, RATE);
    if (this.hangup) {
      // The goodbye is being spoken: wait for it to finish rather than the fallback.
      clearTimeout(this.hangup.maxTimer);
      this.scheduleHangup();
    }
  }

  private receive(data: string): void {
    if (this.closed) return;
    let message: ServerEvent;
    try {
      message = JSON.parse(data) as ServerEvent;
    } catch {
      return;
    }
    switch (message.type) {
      case "conversation_initiation_metadata":
        this.ready = true;
        this.handlers.trace("AI agent: session ready (ElevenLabs)");
        this.handlers.ready?.();
        break;
      case "audio": {
        const id = message.audio_event.event_id;
        if (typeof id === "number") {
          if (id < this.interruptedBefore) break;
          if (this.quietAfter !== null && id > this.quietAfter) {
            if (!this.keptQuiet) this.handlers.trace("AI agent: said more after its goodbye and end_call — not played");
            this.keptQuiet = true;
            break;
          }
          if (id !== this.replyEventId) {
            this.replyEventId = id;
            this.replyAfterLead = true;
            this.replyTextSeen = false;
          }
        }
        const pcm = fromBase64(message.audio_event.audio_base_64);
        if (this.firstAudio) {
          this.firstAudio = false;
          this.handlers.trace("AI agent: first audio from ElevenLabs");
        } else if (!this.replying && this.lastVoiceAt) {
          this.handlers.trace(`AI agent: replied ${Date.now() - this.lastVoiceAt} ms after the lead's last sound`);
        }
        this.replying = true;
        if (this.holding) this.held.push(pcm);
        else this.play(pcm);
        break;
      }
      case "interruption": {
        const id = message.interruption_event?.event_id;
        if (typeof id === "number") this.interruptedBefore = Math.max(this.interruptedBefore, id);
        this.playsUntil = Date.now();
        this.handlers.interrupt();
        break;
      }
      case "user_transcript": {
        const text = message.user_transcription_event.user_transcript.trim();
        if (!text) break;
        this.replyAfterLead = false;
        this.handlers.trace(`AI agent: heard "${text}"`);
        this.handlers.trace(`lead: ${text}`);
        this.handlers.transcript?.("lead", text, "turn");
        break;
      }
      case "agent_response": {
        const text = message.agent_response_event.agent_response.trim();
        if (!text) break;
        if (this.quietAfter !== null && this.replyTextSeen) {
          // The goodbye's text came already: this is a later reply, whose audio is not played.
          this.handlers.trace(`agent (after end_call, not played): ${text}`);
          break;
        }
        this.replyTextSeen = true;
        this.handlers.trace(`agent (turn): ${text}`);
        this.handlers.transcript?.("agent", text, "turn");
        break;
      }
      case "agent_response_correction": {
        const text = message.agent_response_correction_event.corrected_agent_response.trim();
        if (text) this.handlers.trace(`agent (interrupted): ${text}`);
        break;
      }
      case "ping":
        this.send({ type: "pong", event_id: message.ping_event.event_id });
        break;
      case "client_tool_call":
        this.tool(message.client_tool_call);
        break;
    }
  }

  private tool(call: { tool_name: string; tool_call_id: string; parameters?: Record<string, unknown> }): void {
    const args = call.parameters ?? {};
    const text = (key: string) => (typeof args[key] === "string" && (args[key] as string).trim() ? (args[key] as string).trim() : null);
    this.send({ type: "client_tool_result", tool_call_id: call.tool_call_id, result: JSON.stringify({ ok: true }), is_error: false });
    if (call.tool_name === "record_outcome") {
      const outcome = text("outcome");
      this.handlers.trace(`AI agent: outcome ${outcome ?? "?"}${text("when") ? ` (${text("when")})` : ""}`);
      if (outcome) {
        this.handlers.outcome({ outcome: outcome as Parameters<AgentHandlers["outcome"]>[0]["outcome"], summary: text("summary"), when: text("when"), whenAt: text("whenAt") });
      }
    } else if (call.tool_name === "end_call") {
      const reason = text("reason") ?? "the agent ended the call";
      this.handlers.trace(`AI agent: ending the call after its goodbye (${reason})`);
      // The goodbye is already being spoken (a reply began after the lead's last words): nothing after it is played.
      // Otherwise the goodbye is still to come, and is played.
      if (this.quietAfter === null && this.replyEventId >= 0 && this.replyAfterLead) this.quietAfter = this.replyEventId;
      if (!this.hangup) {
        this.hangup = { reason, timer: null, maxTimer: setTimeout(() => this.hangUpNow(), HANGUP_MAX_WAIT_MS) };
        this.scheduleHangup();
      }
    } else if (call.tool_name === "wait_for_them") {
      this.handlers.trace("AI agent: waiting for them");
    }
  }

  /** Hang up once the goodbye has played: re-armed by every audio chunk that follows end_call. */
  private scheduleHangup(): void {
    if (!this.hangup) return;
    if (this.hangup.timer) clearTimeout(this.hangup.timer);
    const wait = Math.max(0, this.playsUntil - Date.now()) + HANGUP_AFTER_AUDIO_MS;
    this.hangup.timer = setTimeout(() => this.hangUpNow(), Math.max(wait, 1_500));
  }

  private hangUpNow(): void {
    const pending = this.hangup;
    if (!pending || this.closed) return;
    if (pending.timer) clearTimeout(pending.timer);
    clearTimeout(pending.maxTimer);
    this.hangup = null;
    this.handlers.trace(`AI agent: hanging up (${pending.reason})`);
    this.handlers.hangup(pending.reason);
  }
}
