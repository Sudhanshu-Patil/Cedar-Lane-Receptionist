import { book, cancel, checkAvailability, findBookings, markLate, reschedule } from "./calendar.js";
import { SERVICES } from "./config.js";
import { logCall, upsertContact } from "./sheets.js";

export type Ctx = { channel: "chat" | "voice" };

const str = (description: string) => ({ type: "string", description });
const DATE = str("YYYY-MM-DD, taken from the date table in the system prompt");
const TIME = str("HH:MM 24-hour shop-local time, e.g. 15:30");
const SERVICE = { type: "string", enum: Object.keys(SERVICES), description: "service key" };
const PHONE = str("phone digits exactly as the caller said them, spaces fine (e.g. '4 1 5 5 5 5 0 1 90'). Do not regroup or retype digits; the server normalizes.");
const EVENT_ID = str("event_id returned by find_bookings");

// One list, used for the Gemini chat loop AND sent to Vapi. `filler` is what Vapi says while the tool runs.
export const TOOLS: {
  name: string; description: string; parameters: object; filler?: string;
  run: (args: any, ctx: Ctx) => Promise<unknown>;
}[] = [
  {
    name: "check_availability",
    description: "Check if a service can be booked at a date/time. Returns open alternatives that day if not.",
    parameters: { type: "object", properties: { date: DATE, time: TIME, service: SERVICE }, required: ["date", "time", "service"] },
    filler: "Let me check...",
    run: (a) => checkAvailability(a),
  },
  {
    name: "book_appointment",
    description: "Book the appointment. Only after the caller agreed to the exact slot, gave name + phone, AND confirmed your read-back of both (names get misheard).",
    parameters: {
      type: "object",
      properties: { date: DATE, time: TIME, service: SERVICE, name: str("caller's name"), phone: PHONE, vehicle: str("make/model if given") },
      required: ["date", "time", "service", "name", "phone"],
    },
    filler: "One sec, booking that...",
    run: async (a) => {
      const r = await book(a);
      if (r.booked) await upsertContact({ phone: a.phone, name: a.name, vehicle: a.vehicle });
      return r;
    },
  },
  {
    name: "find_bookings",
    description: "Look up the caller's upcoming appointments by phone. Use before reschedule/cancel/running-late.",
    parameters: { type: "object", properties: { phone: PHONE }, required: ["phone"] },
    filler: "Let me pull that up...",
    run: (a) => findBookings(a),
  },
  {
    name: "reschedule_appointment",
    description: "Move an existing booking to a new date/time (optionally a different service).",
    parameters: {
      type: "object",
      properties: { event_id: EVENT_ID, phone: PHONE, date: DATE, time: TIME, service: SERVICE },
      required: ["event_id", "phone", "date", "time"],
    },
    filler: "Okay, moving that...",
    run: (a) => reschedule(a),
  },
  {
    name: "cancel_appointment",
    description: "Cancel an existing booking. Confirm with the caller first.",
    parameters: { type: "object", properties: { event_id: EVENT_ID, phone: PHONE }, required: ["event_id", "phone"] },
    run: (a) => cancel(a),
  },
  {
    name: "mark_running_late",
    description: "Note on the booking that the caller is running late.",
    parameters: {
      type: "object",
      properties: { event_id: EVENT_ID, phone: PHONE, minutes_late: { type: "number" } },
      required: ["event_id", "phone", "minutes_late"],
    },
    run: (a) => markLate(a),
  },
  {
    name: "log_call",
    description: "Log this conversation to the sheet. Call exactly once, when the caller is wrapping up (before saying goodbye).",
    parameters: {
      type: "object",
      properties: {
        phone: str("caller's phone if known"),
        name: str("caller's name if known"),
        vehicle: str("vehicle if mentioned"),
        intent: { type: "string", enum: ["booking", "reschedule", "cancel", "pricing", "hours", "prep", "vehicle_question", "running_late", "complaint", "other"] },
        summary: str("one or two sentences: what they wanted and what happened"),
        outcome: str("e.g. 'booked Thu Nov 5 4:30 PM', 'answered pricing', 'handed off to owner'"),
        needs_human: { type: "boolean", description: "true if a human must follow up" },
      },
      required: ["intent", "summary", "outcome", "needs_human"],
    },
    run: (a, ctx) => logCall({ ...a, channel: ctx.channel }),
  },
];

/** Never throws: errors go back to the model as data so it can recover ("that booking isn't under this number"). */
export async function runTool(name: string, args: unknown, ctx: Ctx) {
  const tool = TOOLS.find((t) => t.name === name);
  try {
    if (!tool) throw new Error(`unknown tool ${name}`);
    const result = await tool.run(args ?? {}, ctx);
    console.log(`[tool] ${name}`, JSON.stringify(args), "->", JSON.stringify(result));
    return result;
  } catch (e: any) {
    console.error(`[tool] ${name} failed`, e?.message);
    return { error: e?.message ?? String(e) };
  }
}
