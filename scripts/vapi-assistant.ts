// Saves the same assistant the phone line builds per call into your Vapi account,
// so you can test it in the browser ("Talk to Assistant"). `npm run vapi`
// The phone number still uses the dynamic /vapi assistant-request path (fresh date table per call);
// re-run this script each day you test, since the saved prompt's date table is frozen at save time.
import "dotenv/config";
import { assistant } from "../src/vapi.js";

const key = process.env.VAPI_API_KEY;
if (!key) throw new Error("set VAPI_API_KEY in .env (Vapi dashboard -> API Keys -> private key)");
const api = (path: string, method = "GET", body?: unknown) =>
  fetch(`https://api.vapi.ai${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data)}`);
    return data;
  });

const config = assistant();
const existing = ((await api("/assistant")) as any[]).find((a) => a.name === config.name);
const saved = existing ? await api(`/assistant/${existing.id}`, "PATCH", config) : await api("/assistant", "POST", config);
console.log(`${existing ? "updated" : "created"} assistant ${saved.id}. Open it in the Vapi dashboard and click "Talk to Assistant".`);

// Point every phone number at our webhook (no fixed assistant -> it asks /vapi per call). Quick tunnels change URL on restart.
for (const n of (await api("/phone-number")) as any[]) {
  await api(`/phone-number/${n.id}`, "PATCH", { assistantId: null, server: config.server });
  console.log(`phone ${n.number} -> ${config.server.url}`);
}
