import "dotenv/config";
import { readFileSync } from "node:fs";
import { google, calendar_v3 } from "googleapis";
import { DateTime } from "luxon";
import { HOURS, SERVICES, SLOT_STEP_MIN, TZ } from "./config.js";

const sa = JSON.parse(readFileSync(process.env.GOOGLE_SA_JSON!, "utf8"));
export const auth = new google.auth.JWT({
  email: sa.client_email,
  key: sa.private_key,
  scopes: ["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/spreadsheets"],
});
export const cal = google.calendar({ version: "v3", auth });
const calendarId = process.env.CALENDAR_ID!;

type Interval = { start: DateTime; end: DateTime };

export const now = () => DateTime.now().setZone(TZ);
const eventStart = (e: calendar_v3.Schema$Event) => DateTime.fromISO(e.start!.dateTime!, { zone: TZ });
const digits = (raw: string) => String(raw ?? "").replace(/o/gi, "0").replace(/\D/g, ""); // speech-to-text writes "oh" as "o"

// ---------- pure helpers (tested in scripts/check.ts) ----------

/** "(415) 555-0190", "+1 415 555 0190" -> "415-555-0190". null if not a 10-digit US number. */
export function normalizePhone(raw: string): string | null {
  let d = digits(raw);
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : null;
}

export function label(dt: DateTime) {
  return dt.toFormat("ccc LLL d, h:mm a"); // "Thu Nov 5, 4:30 PM"
}

function openHours(day: DateTime): Interval | null {
  const h = HOURS[day.weekday];
  if (!h) return null;
  const at = (hm: string) => DateTime.fromISO(`${day.toISODate()}T${hm}`, { zone: TZ });
  return { start: at(h[0]), end: at(h[1]) };
}

/** Why a slot can't be booked, or null if it can. */
export function slotProblem(slot: Interval, busy: Interval[], at: DateTime): string | null {
  const hours = openHours(slot.start);
  if (!hours) return "we're closed that day";
  if (slot.start < hours.start || slot.end > hours.end)
    return `outside business hours (${hours.start.toFormat("h:mm a")}-${hours.end.toFormat("h:mm a")}, the service must finish by closing)`;
  if (slot.start <= at) return "that time has already passed";
  // Single bay: any overlap blocks the slot.
  if (busy.some((b) => slot.start < b.end && b.start < slot.end)) return "that slot is already booked";
  return null;
}

/** Open start times that day for a service, nearest to `target` first. */
export function alternatives(target: DateTime, minutes: number, busy: Interval[], at: DateTime, max = 3): DateTime[] {
  const hours = openHours(target);
  if (!hours) return [];
  const out: DateTime[] = [];
  for (let s = hours.start; s < hours.end; s = s.plus({ minutes: SLOT_STEP_MIN })) {
    if (!slotProblem({ start: s, end: s.plus({ minutes }) }, busy, at)) out.push(s);
  }
  return out.sort((a, b) => Math.abs(+a - +target) - Math.abs(+b - +target)).slice(0, max);
}

// ---------- Google Calendar ----------

function parseSlot(date: string, time: string, service: string) {
  const svc = SERVICES[service];
  if (!svc) throw new Error(`unknown service "${service}". Valid: ${Object.keys(SERVICES).join(", ")}`);
  const start = DateTime.fromISO(`${date}T${time}`, { zone: TZ });
  if (!start.isValid) throw new Error(`bad date/time "${date} ${time}", expected YYYY-MM-DD and HH:MM (24h)`);
  return { svc, start, end: start.plus({ minutes: svc.minutes }) };
}

async function busyOn(day: DateTime, excludeEventId?: string): Promise<Interval[]> {
  const res = await cal.events.list({
    calendarId,
    timeMin: day.startOf("day").toISO()!,
    timeMax: day.endOf("day").toISO()!,
    singleEvents: true,
    maxResults: 250,
  });
  return (res.data.items ?? [])
    .filter((e) => e.id !== excludeEventId && e.status !== "cancelled" && e.transparency !== "transparent")
    .map((e) => ({
      // all-day events (shop closures) only have .date
      start: DateTime.fromISO(e.start?.dateTime ?? e.start!.date!, { zone: TZ }),
      end: DateTime.fromISO(e.end?.dateTime ?? e.end!.date!, { zone: TZ }),
    }));
}

async function check(date: string, time: string, service: string, excludeEventId?: string) {
  const { svc, start, end } = parseSlot(date, time, service);
  const t = now();
  const busy = await busyOn(start, excludeEventId);
  const problem = slotProblem({ start, end }, busy, t);
  return {
    svc, start, end, problem,
    alternatives: problem ? alternatives(start, svc.minutes, busy, t).map((a) => ({ date: a.toISODate(), time: a.toFormat("HH:mm"), label: label(a) })) : [],
  };
}

export async function checkAvailability(a: { date: string; time: string; service: string }) {
  const c = await check(a.date, a.time, a.service);
  return c.problem
    ? { available: false, requested: label(c.start), reason: c.problem, open_alternatives_same_day: c.alternatives }
    : { available: true, requested: label(c.start), service: c.svc.name, ends: c.end.toFormat("h:mm a"), price: c.svc.price };
}

export async function book(a: { date: string; time: string; service: string; name: string; phone: string; vehicle?: string }) {
  const phone = normalizePhone(a.phone);
  if (!phone) return { booked: false, reason: `phone "${a.phone}" has ${digits(a.phone).length} digits, need 10. Re-check against what the caller said (and your read-back) before asking them again.` };
  const name = a.name?.trim();
  if (!name) return { booked: false, reason: "need the caller's name" };
  // Re-check right before inserting, an earlier availability answer may be stale.
  // Not atomic: two bookings for the same slot in the same second could both pass.
  const c = await check(a.date, a.time, a.service);
  if (c.problem) return { booked: false, reason: c.problem, open_alternatives_same_day: c.alternatives };
  const ev = await cal.events.insert({
    calendarId,
    requestBody: {
      summary: `${c.svc.name} - ${name}`,
      description: `Name: ${name}\nPhone: ${phone}\nVehicle: ${a.vehicle || "not given"}\nBooked by AI receptionist`,
      start: { dateTime: c.start.toISO()!, timeZone: TZ },
      end: { dateTime: c.end.toISO()!, timeZone: TZ },
      extendedProperties: { private: { phone, service: a.service, name } },
    },
  });
  return { booked: true, event_id: ev.data.id, when: label(c.start), service: c.svc.name, price: c.svc.price, name, phone };
}

export async function findBookings(a: { phone: string }) {
  const phone = normalizePhone(a.phone);
  if (!phone) return { error: "phone number must be 10 digits" };
  const res = await cal.events.list({
    calendarId,
    privateExtendedProperty: [`phone=${phone}`],
    timeMin: now().toISO()!,
    singleEvents: true,
    orderBy: "startTime",
  });
  const bookings = (res.data.items ?? []).map((e) => ({
    event_id: e.id,
    service: SERVICES[e.extendedProperties?.private?.service ?? ""]?.name ?? e.summary,
    name: e.extendedProperties?.private?.name,
    when: label(eventStart(e)),
  }));
  return { phone, bookings };
}

/** Loads an event and makes sure it belongs to this phone number, so a wrong/hallucinated id can't touch someone else's booking. */
async function ownedEvent(eventId: string, rawPhone: string): Promise<calendar_v3.Schema$Event> {
  const phone = normalizePhone(rawPhone);
  const ev = (await cal.events.get({ calendarId, eventId }).catch(() => null))?.data;
  if (!ev || ev.status === "cancelled") throw new Error("no such booking, call find_bookings first");
  if (!phone || ev.extendedProperties?.private?.phone !== phone) throw new Error("that booking isn't under this phone number");
  return ev;
}

export async function reschedule(a: { event_id: string; phone: string; date: string; time: string; service?: string }) {
  const ev = await ownedEvent(a.event_id, a.phone);
  const service = a.service || ev.extendedProperties!.private!.service!;
  const c = await check(a.date, a.time, service, a.event_id); // don't conflict with itself
  if (c.problem) return { rescheduled: false, reason: c.problem, open_alternatives_same_day: c.alternatives };
  await cal.events.patch({
    calendarId,
    eventId: a.event_id,
    requestBody: {
      summary: `${c.svc.name} - ${ev.extendedProperties!.private!.name}`,
      start: { dateTime: c.start.toISO()!, timeZone: TZ },
      end: { dateTime: c.end.toISO()!, timeZone: TZ },
      extendedProperties: { private: { ...ev.extendedProperties!.private, service } },
    },
  });
  return { rescheduled: true, from: label(eventStart(ev)), to: label(c.start), service: c.svc.name };
}

export async function cancel(a: { event_id: string; phone: string }) {
  const ev = await ownedEvent(a.event_id, a.phone);
  await cal.events.delete({ calendarId, eventId: a.event_id });
  return { cancelled: true, was: `${ev.summary} on ${label(eventStart(ev))}` };
}

export async function markLate(a: { event_id: string; phone: string; minutes_late: number }) {
  const ev = await ownedEvent(a.event_id, a.phone);
  const start = eventStart(ev);
  if (!start.hasSame(now(), "day"))
    return { noted: false, reason: `that booking is ${label(start)}, not today. Ask which appointment they mean.` };
  const note = `Running late ~${a.minutes_late} min (caller said at ${now().toFormat("h:mm a")})`;
  await cal.events.patch({ calendarId, eventId: a.event_id, requestBody: { description: `${ev.description ?? ""}\n${note}` } });
  return { noted: true, slot_held: a.minutes_late <= 15, note };
}
