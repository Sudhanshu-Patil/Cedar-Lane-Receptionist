import "dotenv/config";
import express from "express";
import { chat } from "./agent.js";
import { assistant, saveAssistant, VAPI_URL } from "./vapi.js";
import { logCall } from "./sheets.js";
import { runTool } from "./tools.js";
import { ADDRESS, HOURS, LARGE_VEHICLE_SURCHARGE, PHONE, SERVICES, SHOP, TZ } from "./config.js";
import { now } from "./calendar.js";
import { lastSeedDate, resetDemo } from "./demo.js";

const app = express();
app.set("trust proxy", 1); // behind Render's proxy: req.ip is the visitor, not the proxy
app.use(express.json());
app.use(express.static("public"));

// The site is public and chat/voice cost money per use, so cap how often one visitor can hit them.
// In-memory sliding window per IP; resets on restart, which is fine for one small instance.
const hits = new Map<string, number[]>();
function limit(max: number, windowMin: number): express.RequestHandler {
  return (req, res, next) => {
    const key = `${req.path}|${req.ip}`, now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMin * 60_000);
    if (recent.length >= max) return res.status(429).json({ error: "You've hit the demo limit. Please try again in a little while, or call the shop." });
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}

// Public shop facts for the website, straight from config so the site and the agent never disagree.
app.get("/api/shop", (_req, res) => {
  res.json({ name: SHOP, phone: PHONE, address: ADDRESS, hours: HOURS, services: Object.values(SERVICES), surcharge: LARGE_VEHICLE_SURCHARGE, tz: TZ });
});

// Browser voice calls: refresh the saved assistant (date table, current time) right before each call.
// Only the public key and assistant id reach the browser; the webhook secret stays server-side.
app.post("/api/voice", limit(4, 60), async (_req, res) => {
  if (!process.env.VAPI_PUBLIC_KEY || !process.env.VAPI_API_KEY) return res.status(503).json({ error: "voice not configured" });
  try {
    res.json({ publicKey: process.env.VAPI_PUBLIC_KEY, assistantId: await saveAssistant() });
  } catch (e: any) {
    console.error("[voice]", e?.message);
    res.status(502).json({ error: "voice unavailable" });
  }
});

// ---------- Phase 1: text chat ----------
app.post("/chat", limit(40, 15), async (req, res) => {
  const { sessionId, message } = req.body ?? {};
  if (typeof sessionId !== "string" || typeof message !== "string") return res.status(400).json({ error: "sessionId and message required" });
  if (message.length > 1000) return res.status(400).json({ error: "That message is too long. Please keep it under 1000 characters." });
  try {
    res.json({ reply: await chat(sessionId, message) });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: "Something went wrong on our side. Please try again, or call the shop." });
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

// Public demo (DEMO_RESET=1): once a day after 3 AM shop time, put the calendar back to the seed week.
// The seed events carry the date they were laid down, so this survives sleeps and restarts without
// ever wiping the same day's bookings twice.
if (process.env.DEMO_RESET) {
  const tick = async () => {
    const t = now();
    if (t.hour < 3 || (await lastSeedDate()) === t.toISODate()) return;
    const { deleted, seeded } = await resetDemo();
    console.log(`[demo] daily reset: deleted ${deleted}, seeded ${seeded.length}`);
  };
  const run = () => tick().catch((e) => console.error("[demo] reset failed", e?.message));
  run();
  setInterval(run, 15 * 60_000);
}

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`http://localhost:${port}  (Vapi webhook: ${VAPI_URL})`));
