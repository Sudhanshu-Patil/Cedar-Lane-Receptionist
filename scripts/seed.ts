// Resets the demo calendar to the seed week and makes sure the sheet tabs exist. Safe to re-run.
// Deletes every booking (seeded or made by the agent); events added by hand stay.
import "dotenv/config";
import { resetDemo } from "../src/demo.js";
import { CALL_HEADERS, CONTACT_HEADERS, sheets } from "../src/sheets.js";

const spreadsheetId = process.env.SHEET_ID!;

const { deleted, seeded } = await resetDemo();
console.log(`deleted ${deleted} bookings`);
for (const s of seeded) console.log(`seeded ${s}`);

// Make sure both tabs exist with headers.
const meta = await sheets.spreadsheets.get({ spreadsheetId });
const have = new Set(meta.data.sheets?.map((s) => s.properties?.title));
const missing = ["Contacts", "Calls"].filter((t) => !have.has(t));
if (missing.length)
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) } });
await sheets.spreadsheets.values.update({ spreadsheetId, range: "Contacts!A1", valueInputOption: "RAW", requestBody: { values: [CONTACT_HEADERS] } });
await sheets.spreadsheets.values.update({ spreadsheetId, range: "Calls!A1", valueInputOption: "RAW", requestBody: { values: [CALL_HEADERS] } });
console.log("sheet tabs ready");
