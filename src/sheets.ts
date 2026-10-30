import { google } from "googleapis";
import { DateTime } from "luxon";
import { auth, normalizePhone } from "./calendar.js";
import { TZ } from "./config.js";

const sheets = google.sheets({ version: "v4", auth });
const spreadsheetId = process.env.SHEET_ID!;
const stamp = () => DateTime.now().setZone(TZ).toFormat("yyyy-MM-dd HH:mm");

export const CONTACT_HEADERS = ["Phone", "Name", "Vehicle", "First Contact", "Last Contact", "Last Summary"];
export const CALL_HEADERS = ["Timestamp", "Channel", "Phone", "Name", "Intent", "Summary", "Outcome", "Needs Human"];

/** One row per caller, keyed by normalized phone. Blank fields never overwrite known ones. */
export async function upsertContact(c: { phone: string; name?: string; vehicle?: string; summary?: string }) {
  const phone = normalizePhone(c.phone);
  if (!phone) return;
  const rows = (await sheets.spreadsheets.values.get({ spreadsheetId, range: "Contacts!A2:F" })).data.values ?? [];
  const i = rows.findIndex((r) => r[0] === phone);
  const old = rows[i] ?? [];
  const row = [phone, c.name || old[1] || "", c.vehicle || old[2] || "", old[3] || stamp(), stamp(), c.summary || old[5] || ""];
  if (i < 0) {
    await sheets.spreadsheets.values.append({ spreadsheetId, range: "Contacts!A1", valueInputOption: "RAW", requestBody: { values: [row] } });
  } else {
    await sheets.spreadsheets.values.update({ spreadsheetId, range: `Contacts!A${i + 2}:F${i + 2}`, valueInputOption: "RAW", requestBody: { values: [row] } });
  }
}

export async function logCall(a: {
  channel: string; phone?: string; name?: string; vehicle?: string;
  intent: string; summary: string; outcome: string; needs_human: boolean;
}) {
  const phone = normalizePhone(a.phone ?? "") ?? (a.phone || "");
  await sheets.spreadsheets.values.append({
    spreadsheetId, range: "Calls!A1", valueInputOption: "RAW",
    requestBody: { values: [[stamp(), a.channel, phone, a.name ?? "", a.intent, a.summary, a.outcome, a.needs_human ? "TRUE" : "FALSE"]] },
  });
  if (phone) await upsertContact({ phone, name: a.name, vehicle: a.vehicle, summary: a.summary });
  return { logged: true };
}
