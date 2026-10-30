// Seeds the test calendar + sheet. Safe to re-run: only deletes events it created (seed=1).
import "dotenv/config";
import { google } from "googleapis";
import { DateTime } from "luxon";
import { auth } from "../src/calendar.js";
import { SERVICES, TZ } from "../src/config.js";
import { CALL_HEADERS, CONTACT_HEADERS } from "../src/sheets.js";

const cal = google.calendar({ version: "v3", auth });
const sheets = google.sheets({ version: "v4", auth });
const calendarId = process.env.CALENDAR_ID!;
const spreadsheetId = process.env.SHEET_ID!;

const today = DateTime.now().setZone(TZ).startOf("day");
const next = (weekday: number) => today.plus({ days: ((weekday - today.weekday + 7) % 7) || 7 }); // strictly after today
const thu = next(4), fri = next(5), sat = next(6);
// Same-day booking ~30-60 min from now, for the running-late demo. Re-run seed right before recording.
const now = DateTime.now().setZone(TZ);
const soon = now.startOf("hour").plus({ minutes: now.minute < 30 ? 60 : 90 });

const SEED = [
  // Thursday 2:30-4:30 taken -> "3:30 interior detail & wash" (90 min) is full, 4:30 is open. The spec's example.
  { day: thu, from: "14:30", to: "16:30", service: "full_detail", name: "Mike Chen", phone: "415-555-0111" },
  { day: thu, from: "09:00", to: "10:30", service: "interior_wash", name: "Dana Ortiz", phone: "415-555-0122" },
  // Known caller for reschedule / cancel / running-late demos.
  { day: fri, from: "10:00", to: "11:30", service: "interior_wash", name: "Priya Patel", phone: "415-555-0133" },
  // Today, for "I'm running late".
  { day: today, from: soon.toFormat("HH:mm"), to: soon.plus({ minutes: 60 }).toFormat("HH:mm"), service: "exterior_wash", name: "Jordan Lee", phone: "415-555-0155" },
  // Saturday fully booked.
  { day: sat, from: "09:00", to: "16:00", service: "full_detail", name: "Fleet block (Bay Rentals)", phone: "415-555-0144" },
];

const old = await cal.events.list({ calendarId, privateExtendedProperty: ["seed=1"], singleEvents: true, maxResults: 250 });
for (const e of old.data.items ?? []) await cal.events.delete({ calendarId, eventId: e.id! });

for (const s of SEED) {
  const at = (hm: string) => DateTime.fromISO(`${s.day.toISODate()}T${hm}`, { zone: TZ }).toISO()!;
  await cal.events.insert({
    calendarId,
    requestBody: {
      summary: `${SERVICES[s.service].name} - ${s.name}`,
      description: `Name: ${s.name}\nPhone: ${s.phone}\n(seeded test booking)`,
      start: { dateTime: at(s.from), timeZone: TZ },
      end: { dateTime: at(s.to), timeZone: TZ },
      extendedProperties: { private: { phone: s.phone, service: s.service, name: s.name, seed: "1" } },
    },
  });
  console.log(`seeded ${s.day.toFormat("ccc LLL d")} ${s.from}-${s.to} ${s.name}`);
}

// Make sure both tabs exist with headers.
const meta = await sheets.spreadsheets.get({ spreadsheetId });
const have = new Set(meta.data.sheets?.map((s) => s.properties?.title));
const missing = ["Contacts", "Calls"].filter((t) => !have.has(t));
if (missing.length)
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) } });
await sheets.spreadsheets.values.update({ spreadsheetId, range: "Contacts!A1", valueInputOption: "RAW", requestBody: { values: [CONTACT_HEADERS] } });
await sheets.spreadsheets.values.update({ spreadsheetId, range: "Calls!A1", valueInputOption: "RAW", requestBody: { values: [CALL_HEADERS] } });
console.log("sheet tabs ready");
