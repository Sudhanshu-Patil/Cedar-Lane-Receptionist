import "dotenv/config";
import express from "express";
import { chat } from "./agent.js";
import { assistant, VAPI_URL } from "./vapi.js";
import { logCall } from "./sheets.js";
import { runTool } from "./tools.js";

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
// The phone number has no fixed assistant, so each call requests one here (fresh date table).
// Facts from tool calls are kept per call for the end-of-call log row. In-memory.
type CallState = { name?: string; phone?: string; intent?: string; outcome?: string };
const calls = new Map<string, CallState>();
const INTENT: Record<string, string> = { book_appointment: "booking", reschedule_appointment: "reschedule", cancel_appointment: "cancel", mark_running_late: "running_late" };

app.post("/vapi", async (req, res) => {
  const msg = req.body?.message ?? {};
  if (process.env.VAPI_SECRET && req.get("x-vapi-secret") !== process.env.VAPI_SECRET) {
    console.warn(`[vapi] rejected ${msg.type ?? "?"}: missing/wrong x-vapi-secret`);
    return res.sendStatus(401);
  }
  if (msg.type !== "tool-calls") console.log(`[vapi] ${msg.type}`);
  const callId: string | undefined = msg.call?.id;
  const callerNumber: string | undefined = msg.call?.customer?.number;

  if (msg.type === "assistant-request") return res.json({ assistant: assistant(callerNumber) });

  if (msg.type === "tool-calls") {
    const results = await Promise.all((msg.toolCallList ?? []).map(async (tc: any) => {
      const name: string = tc.function.name;
      const args = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments;
      const result: any = await runTool(name, args, "voice");
      if (callId) {
        const s = calls.get(callId) ?? {};
        calls.set(callId, s);
        s.name = args?.name || s.name;
        s.phone = args?.phone || s.phone;
        if (INTENT[name]) s.intent = INTENT[name];
        if (result?.booked) s.outcome = `booked ${result.when}`;
        if (result?.rescheduled) s.outcome = `rescheduled to ${result.to}`;
        if (result?.cancelled) s.outcome = `cancelled ${result.was}`;
      }
      return { toolCallId: tc.id, result: JSON.stringify(result) };
    }));
    return res.json({ results });
  }

  if (msg.type === "end-of-call-report" && callId) {
    const s = calls.get(callId) ?? {};
    calls.delete(callId);
    // Vapi's analysis supplies summary/intent/needs_human. Outcome, phone and name come from
    // actual tool results, since the analysis can claim a booking that never happened.
    const d = msg.analysis?.structuredData ?? {};
    const claimsAction = /book|resched|cancel/i.test(d.outcome ?? "");
    await logCall({
      channel: "voice",
      phone: s.phone || callerNumber,
      name: s.name || d.name,
      vehicle: d.vehicle,
      intent: s.intent || d.intent || "other",
      summary: d.summary || msg.analysis?.summary || msg.summary || "(no summary)",
      outcome: s.outcome || (d.outcome && !claimsAction ? d.outcome : `no booking made (ended: ${msg.endedReason})`),
      needs_human: d.needs_human === true,
    }).catch((e) => console.error("call log failed", e));
  }
  res.json({});
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`http://localhost:${port}  (Vapi webhook: ${VAPI_URL})`));
