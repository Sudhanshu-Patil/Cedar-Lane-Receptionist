// Offline checks for the slot logic. `npm run check`
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { alternatives, normalizePhone, slotProblem } from "../src/calendar.js";
import { TZ } from "../src/config.js";

const t = (iso: string) => DateTime.fromISO(iso, { zone: TZ });
const now = t("2026-11-02T08:00"); // Monday morning
const thu = (hm: string) => t(`2026-11-05T${hm}`);
const busy = [{ start: thu("14:30"), end: thu("16:30") }];
const slot = (hm: string, min: number) => ({ start: thu(hm), end: thu(hm).plus({ minutes: min }) });

// phone
assert.equal(normalizePhone("415-555-0190"), "415-555-0190");
assert.equal(normalizePhone("+1 (415) 555 0190"), "415-555-0190");
assert.equal(normalizePhone("555-0190"), null);

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

console.log("all checks passed");
