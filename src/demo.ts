// Demo calendar: the seed week, laid down relative to now() so "Thursday 3:30 is full" always holds for the coming Thursday.
import { DateTime } from "luxon";
import { cal, now } from "./calendar.js";
import { HOURS, SERVICES, TZ } from "./config.js";

const calendarId = process.env.CALENDAR_ID!;

type Seed = { day: DateTime; from: string; to: string; service: string; name: string; phone: string };

export function seedEvents(t: DateTime): Seed[] {
  const today = t.startOf("day");
  const next = (weekday: number) => today.plus({ days: ((weekday - today.weekday + 7) % 7) || 7 }); // strictly after today
  const thu = next(4), fri = next(5), sat = next(6);
  const events: Seed[] = [
    // Thursday 2:30-4:30 taken -> "3:30 interior detail & wash" (90 min) is full, 4:30 is open. The spec's example.
    { day: thu, from: "14:30", to: "16:30", service: "full_detail", name: "Mike Chen", phone: "415-555-0111" },
    { day: thu, from: "09:00", to: "10:30", service: "interior_wash", name: "Dana Ortiz", phone: "415-555-0122" },
    // Known caller for reschedule / cancel demos.
    { day: fri, from: "10:00", to: "11:30", service: "interior_wash", name: "Priya Patel", phone: "415-555-0133" },
    // Saturday fully booked.
    { day: sat, from: "09:00", to: "16:00", service: "full_detail", name: "Fleet block (Bay Rentals)", phone: "415-555-0144" },
  ];
  // Today, for "I'm running late": an hour-long wash 30-60 min from now, but never before opening.
  // Skipped when the shop is closed today or the slot would run past closing.
  const hours = HOURS[t.weekday];
  if (hours) {
    const open = DateTime.fromISO(`${today.toISODate()}T${hours[0]}`, { zone: TZ });
    const close = DateTime.fromISO(`${today.toISODate()}T${hours[1]}`, { zone: TZ });
    const soon = DateTime.max(open, t.startOf("hour").plus({ minutes: t.minute < 30 ? 60 : 90 }));
    if (soon.plus({ minutes: 60 }) <= close)
      events.push({ day: today, from: soon.toFormat("HH:mm"), to: soon.plus({ minutes: 60 }).toFormat("HH:mm"), service: "exterior_wash", name: "Jordan Lee", phone: "415-555-0155" });
  }
  return events;
}

/** Shop-local date the seed week was last laid down, or undefined if never (or by an older seed). */
export async function lastSeedDate(): Promise<string | undefined> {
  // A small maxResults can come back as an empty page plus a nextPageToken when filtering, so ask for a full page.
  const res = await cal.events.list({ calendarId, privateExtendedProperty: ["seed=1"], maxResults: 250 });
  return res.data.items?.find((e) => e.extendedProperties?.private?.seedDate)?.extendedProperties?.private?.seedDate;
}

/** Deletes every booking (seeded or made by the agent) and lays the seed week down again. */
export async function resetDemo(): Promise<{ deleted: number; seeded: string[] }> {
  const t = now();
  let deleted = 0, pageToken: string | undefined;
  do {
    const res = await cal.events.list({ calendarId, singleEvents: true, maxResults: 250, pageToken });
    for (const e of res.data.items ?? []) {
      if (!e.extendedProperties?.private?.phone) continue; // only bookings; anything added by hand stays
      await cal.events.delete({ calendarId, eventId: e.id! });
      deleted++;
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  const seeded: string[] = [];
  for (const s of seedEvents(t)) {
    const at = (hm: string) => DateTime.fromISO(`${s.day.toISODate()}T${hm}`, { zone: TZ }).toISO()!;
    await cal.events.insert({
      calendarId,
      requestBody: {
        summary: `${SERVICES[s.service].name} - ${s.name}`,
        description: `Name: ${s.name}\nPhone: ${s.phone}\n(seeded test booking)`,
        start: { dateTime: at(s.from), timeZone: TZ },
        end: { dateTime: at(s.to), timeZone: TZ },
        extendedProperties: { private: { phone: s.phone, service: s.service, name: s.name, seed: "1", seedDate: t.toISODate()! } },
      },
    });
    seeded.push(`${s.day.toFormat("ccc LLL d")} ${s.from}-${s.to} ${s.name}`);
  }
  return { deleted, seeded };
}
