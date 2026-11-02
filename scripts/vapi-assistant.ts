// `npm run vapi`: saves the assistant to Vapi for the dashboard's "Talk" button and points phone numbers at /vapi.
// The saved prompt's date table is fixed at save time, so re-run it on test days.
import "dotenv/config";
import { assistant, saveAssistant, vapiApi, VAPI_URL } from "../src/vapi.js";

if (!process.env.VAPI_API_KEY) throw new Error("set VAPI_API_KEY in .env (Vapi dashboard -> API Keys -> private key)");
console.log(`saved assistant ${await saveAssistant()}. Open it in the Vapi dashboard and click "Talk to Assistant".`);

// No fixed assistant: each call requests one from /vapi.
const { server } = assistant();
for (const n of (await vapiApi("/phone-number")) as any[]) {
  await vapiApi(`/phone-number/${n.id}`, "PATCH", { assistantId: null, server });
  console.log(`phone ${n.number} -> ${VAPI_URL}`);
}
