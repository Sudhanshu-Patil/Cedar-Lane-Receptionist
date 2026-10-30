import "dotenv/config";
import express from "express";
import { chat } from "./agent.js";
import { SHOP } from "./config.js";
import { buildSystemPrompt } from "./prompt.js";
import { logCall } from "./sheets.js";
import { runTool, TOOLS } from "./tools.js";

const app = express();
app.use(express.json());
app.use(express.static("public"));

// ---------- Phase 1: text chat ----------
app.post("/chat", async (req, res) => {
  const { sessionId, message } = req.body ?? {};
  if (typeof sessionId !== "string" || typeof message !== "string") return res.status(400).json({ error: "sessionId and message required" });
  try {
    res.json({ reply: await chat(sessionId, message) });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: e?.message });
  }
});

// ---------- Phase 2: Vapi ----------
// The Vapi phone number has no assistant attached, only Server URL = PUBLIC_URL/vapi.
// So every inbound call asks us for its assistant -> fresh date table, same prompt + tools as chat.
const VAPI_URL = `${process.env.PUBLIC_URL}/vapi`;
const loggedCalls = new Set<string>(); // calls where the model already called log_call

function assistant(callerNumber?: string) {
  const server = { url: VAPI_URL, ...(process.env.VAPI_SECRET && { secret: process.env.VAPI_SECRET }) };
  return {
    name: "Cedar Lane Receptionist",
    firstMessage: `Hi, thanks for calling ${SHOP.replace(" Auto Detailing", "")}, how can I help?`,
    model: {
      provider: "google",
      model: process.env.VAPI_MODEL || "gemini-3.8-flash",
      temperature: 0.3,
      maxTokens: 150, // short replies = faster TTS start
      messages: [{ role: "system", content: buildSystemPrompt("voice", callerNumber) }],
      tools: [
        ...TOOLS.map((t) => ({
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
    stopSpeakingPlan: { numWords: 1, voiceSeconds: 0.2, backoffSeconds: 1 }, // caller can interrupt
    backgroundSound: "office",
    serverMessages: ["end-of-call-report"],
    server,
  };
}

app.post("/vapi", async (req, res) => {
  if (process.env.VAPI_SECRET && req.get("x-vapi-secret") !== process.env.VAPI_SECRET) return res.sendStatus(401);
  const msg = req.body?.message ?? {};
  const callId: string | undefined = msg.call?.id;
  const callerNumber: string | undefined = msg.call?.customer?.number;

  if (msg.type === "assistant-request") return res.json({ assistant: assistant(callerNumber) });

  if (msg.type === "tool-calls") {
    const results = await Promise.all((msg.toolCallList ?? []).map(async (tc: any) => {
      const args = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments;
      if (tc.function.name === "log_call" && callId) loggedCalls.add(callId);
      const result = await runTool(tc.function.name, args, { channel: "voice" });
      return { toolCallId: tc.id, result: JSON.stringify(result) };
    }));
    return res.json({ results });
  }

  // Caller hung up before the agent wrapped up: still log the call so the sheet is complete.
  if (msg.type === "end-of-call-report" && callId && !loggedCalls.delete(callId)) {
    await logCall({
      channel: "voice", phone: callerNumber, intent: "other",
      summary: msg.analysis?.summary || msg.summary || "(no summary)",
      outcome: `call ended (${msg.endedReason}) before wrap-up`, needs_human: false,
    }).catch((e) => console.error("fallback log failed", e));
  }
  res.json({});
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`http://localhost:${port}  (Vapi webhook: ${VAPI_URL})`));
