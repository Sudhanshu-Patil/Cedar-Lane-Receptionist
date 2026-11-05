// Offline checks for the slot logic. `npm run check`
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { alternatives, normalizePhone, slotProblem } from "../src/calendar.js";
import { TZ } from "../src/config.js";
import { seedEvents } from "../src/demo.js";

const t = (iso: string) => DateTime.fromISO(iso, { zone: TZ });
const now = t("2026-11-02T08:00"); // Monday morning
const thu = (hm: string) => t(`2026-11-05T${hm}`);
const busy = [{ start: thu("14:30"), end: thu("16:30") }];
const slot = (hm: string, min: number) => ({ start: thu(hm), end: thu(hm).plus({ minutes: min }) });

// phone
assert.equal(normalizePhone("415-555-0190"), "415-555-0190");
assert.equal(normalizePhone("+1 (415) 555 0190"), "415-555-0190");
assert.equal(normalizePhone("555-0190"), null);
assert.equal(normalizePhone("4 1 5 5 5 5 o 1 90"), "415-555-0190"); // speech-to-text "oh"
assert.equal(normalizePhone("41555550190"), null); // 11 digits not starting with 1 -> reject, never guess

// the spec's example: 3:30 interior & wash (90m) is full, 4:30 is open
assert.match(slotProblem(slot("15:30", 90), busy, now)!, /booked/);
assert.equal(slotProblem(slot("16:30", 90), busy, now), null);
assert.equal(alternatives(thu("15:30"), 90, busy, now)[0].toFormat("HH:mm"), "16:30");
// back-to-back is fine, 1 minute overlap is not
assert.equal(slotProblem(slot("13:00", 90), busy, now), null);
assert.match(slotProblem({ start: thu("13:01"), end: thu("14:31") }, busy, now)!, /booked/);
// must finish by closing (18:00 weekdays)
assert.match(slotProblem(slot("17:00", 90), [], now)!, /business hours/);
assert.match(slotProblem(slot("07:30", 60), [], now)!, /business hours/);
// Sunday closed, Saturday closes 16:00
assert.match(slotProblem({ start: t("2026-11-08T10:00"), end: t("2026-11-08T11:00") }, [], now)!, /closed/);
assert.match(slotProblem({ start: t("2026-11-07T15:30"), end: t("2026-11-07T16:30") }, [], now)!, /business hours/);
// past
assert.match(slotProblem({ start: t("2026-11-02T07:00"), end: t("2026-11-02T08:00") }, [], t("2026-11-02T12:00"))!, /business hours|passed/);
assert.match(slotProblem({ start: t("2026-11-02T09:00"), end: t("2026-11-02T10:00") }, [], t("2026-11-02T12:00"))!, /passed/);
// DST end (Nov 1 2026): local wall-clock times still line up
assert.equal(t("2026-11-01T10:00").plus({ minutes: 60 }).toFormat("HH:mm"), "11:00");

// demo seed: dates follow now(); the same-day "running late" booking stays inside opening hours
const names = (ts: string) => seedEvents(t(ts)).map((e) => `${e.day.toFormat("ccc d")} ${e.from} ${e.name}`);
assert.deepEqual(names("2026-11-02T03:00").slice(0, 1), ["Thu 5 14:30 Mike Chen"]); // Monday 3 AM -> this Thursday
assert.ok(names("2026-11-02T03:00").includes("Mon 2 08:00 Jordan Lee")); // clamped to opening, not 4 AM
assert.ok(names("2026-11-02T13:10").includes("Mon 2 14:00 Jordan Lee")); // 30-60 min from now
assert.ok(!names("2026-11-02T17:20").some((n) => n.includes("Jordan"))); // would run past 6 PM close
assert.ok(!names("2026-11-08T10:00").some((n) => n.includes("Jordan"))); // Sunday: closed
assert.deepEqual(names("2026-11-05T03:00").slice(0, 1), ["Thu 12 14:30 Mike Chen"]); // on a Thursday -> next week's
for (const e of seedEvents(t("2026-11-04T09:00"))) // every seed fits business hours and the future
  assert.equal(slotProblem({ start: t(`${e.day.toISODate()}T${e.from}`), end: t(`${e.day.toISODate()}T${e.to}`) }, [], t("2026-11-04T09:00")), null);

console.log("all checks passed");
