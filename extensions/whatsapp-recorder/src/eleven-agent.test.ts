import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ElevenAgent } from "./eleven-agent";
import type { AgentHandlers } from "./live-agent";

class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = 1;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  deliver(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const realWebSocket = globalThis.WebSocket;
beforeEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;
});
afterEach(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
});

const audio = (eventId: number) => ({ type: "audio", audio_event: { audio_base_64: Buffer.from(new Int16Array(160).buffer).toString("base64"), event_id: eventId } });
const said = (text: string) => ({ type: "agent_response", agent_response_event: { agent_response: text } });
const heard = (text: string) => ({ type: "user_transcript", user_transcription_event: { user_transcript: text } });
const tool = (name: string, parameters: Record<string, unknown> = {}) => ({ type: "client_tool_call", client_tool_call: { tool_name: name, tool_call_id: `t-${name}`, parameters } });

function setup(firstMessage = "") {
  const played: number[] = [];
  const traces: string[] = [];
  const transcript: string[] = [];
  let playing = 0;
  const handlers: AgentHandlers = {
    play: () => played.push(playing),
    interrupt: () => {},
    hangup: () => {},
    outcome: () => {},
    transcript: (who, text) => transcript.push(`${who}: ${text}`),
    trace: (step) => traces.push(step),
    token: async () => {
      throw new Error("unused");
    },
  };
  const agent = new ElevenAgent(handlers, {
    token: "",
    model: "elevenlabs-realtime",
    websocketUrl: "",
    elevenlabs: { signedUrl: "wss://example.test", override: { agent: { prompt: { prompt: "x" }, first_message: firstMessage, language: "en" }, tts: { voice_id: "v" } } },
  });
  agent.start();
  const socket = FakeSocket.last!;
  socket.deliver({ type: "conversation_initiation_metadata" });
  /** Delivers `message`; audio it plays is tagged with its event id. */
  const send = (message: ReturnType<typeof audio> | object) => {
    if ("audio_event" in message) playing = (message as ReturnType<typeof audio>).audio_event.event_id;
    socket.deliver(message);
  };
  return { agent, send, played, traces, transcript };
}

describe("ElevenAgent", () => {
  test("a reply after its goodbye and end_call is not played", () => {
    const { agent, send, played, traces, transcript } = setup();
    send(heard("No, sorry, wrong number."));
    send(audio(5));
    send(said("Oh, I'm sorry to have bothered you. Have a good day."));
    send(tool("end_call", { reason: "Wrong number" }));
    send(tool("record_outcome", { outcome: "wrong_person", summary: "x" }));
    send(audio(5));
    send(audio(7));
    send(said("[Call note: This call is logged as wrong_person.]"));
    send(audio(7));
    expect(played).toEqual([5, 5]);
    expect(transcript).toEqual(["lead: No, sorry, wrong number.", "agent: Oh, I'm sorry to have bothered you. Have a good day."]);
    expect(traces.some((step) => step.startsWith("agent (after end_call, not played): [Call note"))).toBe(true);
    agent.close();
  });

  test("the goodbye still plays when end_call comes before it", () => {
    const { agent, send, played } = setup();
    send(heard("Okay, bye."));
    send(tool("end_call"));
    send(audio(4));
    send(said("Bye, have a great day!"));
    expect(played).toEqual([4]);
    agent.close();
  });

  test("the goodbye's text after end_call is still the goodbye", () => {
    const { agent, send, transcript } = setup();
    send(heard("No thanks."));
    send(audio(3));
    send(tool("end_call"));
    send(said("No problem, have a good day!"));
    expect(transcript).toEqual(["lead: No thanks.", "agent: No problem, have a good day!"]);
    agent.close();
  });

  test("audio of a reply the lead cut off is dropped", () => {
    const { agent, send, played } = setup();
    send(audio(2));
    send({ type: "interruption", interruption_event: { event_id: 3 } });
    send(audio(2));
    send(audio(4));
    expect(played).toEqual([2, 4]);
    agent.close();
  });
});
