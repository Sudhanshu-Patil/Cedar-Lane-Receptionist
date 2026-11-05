import { buildSystemPrompt } from "./prompt.js";
import { TOOLS } from "./tools.js";

// Render sets RENDER_EXTERNAL_URL on its own, so a deploy needs no PUBLIC_URL.
export const VAPI_URL = `${process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL}/vapi`;

/** Full Vapi assistant config, built from the same prompt + tools as the chat agent. */
export function assistant(callerNumber?: string) {
  // Vapi reads the secret from `secret` or `headers` depending on message type; set both.
  const secret = process.env.VAPI_SECRET;
  const server = { url: VAPI_URL, ...(secret && { secret, headers: { "x-vapi-secret": secret } }) };
  return {
    name: "Cedar Lane Receptionist",
    firstMessage: "Hi, thanks for calling Cedar Lane, how can I help?",
    model: {
      // gpt-4.1-mini: ~0.3s per turn on Vapi, vs 2.6-9.8s measured for Gemini.
      provider: "openai",
      model: "gpt-4.1-mini",
      temperature: 0.3,
      maxTokens: 150, // short replies = faster TTS start
      // Bookings need a 10-digit US number, so only offer caller ID for +1 numbers.
      messages: [{ role: "system", content: buildSystemPrompt("voice", callerNumber?.startsWith("+1") ? callerNumber : undefined) }],
      tools: [
        // Voice calls are logged from the end-of-call report (server.ts), not log_call.
        ...TOOLS.filter((t) => t.name !== "log_call").map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
          server,
          ...(t.filler && { messages: [{ type: "request-start", content: t.filler }] }),
        })),
        { type: "endCall" },
      ],
    },
    // Latency target: under 1.2s from caller stopping to agent speaking.
    transcriber: { provider: "deepgram", model: "nova-3", language: "en" },
    voice: { provider: "vapi", voiceId: "Elliot" },
    startSpeakingPlan: {
      waitSeconds: 0.4,
      transcriptionEndpointingPlan: {
        onPunctuationSeconds: 0.1, // "...Thursday?" -> reply right away
        onNoPunctuationSeconds: 1.0,
        onNumberSeconds: 0.9, // don't cut people off mid phone number
      },
    },
    // Hang up when the agent says the closing line instead of relying on the endCall tool.
    endCallPhrases: ["have a great day"],
    stopSpeakingPlan: { numWords: 1, voiceSeconds: 0.2, backoffSeconds: 1 }, // caller can interrupt
    backgroundSound: "office",
    // After the call, Vapi extracts the same fields log_call takes; the server writes them to the Calls tab.
    analysisPlan: {
      summaryPlan: { enabled: true },
      structuredDataPlan: { enabled: true, schema: TOOLS.find((t) => t.name === "log_call")!.parameters },
    },
    serverMessages: ["end-of-call-report"],
    server,
  };
}

export function vapiApi(path: string, method = "GET", body?: unknown) {
  return fetch(`https://api.vapi.ai${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data)}`);
    return data;
  });
}

let savedId: string | undefined;
/** Saves the current assistant to Vapi (fresh date table) for browser calls and the dashboard. Returns its id. */
export async function saveAssistant(): Promise<string> {
  const config = assistant();
  savedId ??= ((await vapiApi("/assistant")) as any[]).find((a) => a.name === config.name)?.id;
  const saved = savedId ? await vapiApi(`/assistant/${savedId}`, "PATCH", config) : await vapiApi("/assistant", "POST", config);
  return (savedId = saved.id as string);
}
