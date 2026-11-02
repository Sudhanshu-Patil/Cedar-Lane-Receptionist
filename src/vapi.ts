import { SHOP } from "./config.js";
import { buildSystemPrompt } from "./prompt.js";
import { TOOLS } from "./tools.js";

export const VAPI_URL = `${process.env.PUBLIC_URL}/vapi`;

/** Full Vapi assistant config, built from the same prompt + tools as the chat agent. */
export function assistant(callerNumber?: string) {
  // Vapi sends `secret` as the x-vapi-secret header on some message types and `headers` on others; set both.
  const secret = process.env.VAPI_SECRET;
  const server = { url: VAPI_URL, ...(secret && { secret, headers: { "x-vapi-secret": secret } }) };
  return {
    name: "Cedar Lane Receptionist",
    firstMessage: `Hi, thanks for calling ${SHOP.replace(" Auto Detailing", "")}, how can I help?`,
    model: {
      // Voice runs on OpenAI: measured Gemini on Vapi at 2.6-9.8s/turn (Google capacity issues), gpt-4.1-mini is ~0.5s.
      provider: process.env.VAPI_PROVIDER || "openai",
      model: process.env.VAPI_MODEL || "gpt-4.1-mini",
      temperature: 0.3,
      maxTokens: 150, // short replies = faster TTS start
      // Only offer caller ID if it's a US number: bookings need 10-digit US phones, and reading out "+91 72..." derailed a call.
      messages: [{ role: "system", content: buildSystemPrompt("voice", callerNumber?.startsWith("+1") ? callerNumber : undefined) }],
      tools: [
        // log_call is chat-only: on voice the model stalled (silent turn) when asked to call a tool at goodbye.
        // Voice calls are logged from Vapi's end-of-call analysis instead (see analysisPlan + /vapi end-of-call-report).
        ...TOOLS.filter((t) => t.name !== "log_call").map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
          server,
          ...(t.filler && { messages: [{ type: "request-start", content: t.filler }] }),
        })),
        { type: "endCall" },
      ],
    },
    // Latency knobs. Target: caller stops talking -> agent audio starts < 1.2s.
    transcriber: { provider: "deepgram", model: "nova-3", language: "en" },
    voice: { provider: "vapi", voiceId: process.env.VAPI_VOICE || "Elliot" },
    startSpeakingPlan: {
      waitSeconds: 0.4,
      transcriptionEndpointingPlan: {
        onPunctuationSeconds: 0.1, // "...Thursday?" -> reply right away
        onNoPunctuationSeconds: 1.0,
        onNumberSeconds: 0.9, // don't cut people off mid phone number
      },
    },
    // Hang up deterministically when the agent says the closing line (the prompt mandates it); the model kept forgetting endCall.
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
