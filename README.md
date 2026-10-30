# Cedar Lane Auto Detailing: AI Receptionist

A TypeScript agent that uses Gemini function calling. It books appointments in Google Calendar and logs callers to Google Sheets. Phase 1 is a text chat. Phase 2 is a phone line on Vapi that uses the same prompt and the same tools.

## Run
```bash
npm i
cp .env.example .env              # fill in the keys (see Setup)
npm run seed                      # test events + sheet tabs/headers
npm run check                     # offline asserts for the slot logic
npm start                         # http://localhost:3000
```

## Setup
1. Google Cloud: enable the **Calendar API** and the **Sheets API**. Create a **service account** and download its JSON key to `./service-account.json`.
2. Create a new Google Calendar. In its settings, share it with the service account's `client_email` ("Make changes to events"). Put the calendar ID in `CALENDAR_ID`.
3. Create a Google Sheet and share it with the same email as Editor. Put the sheet ID from its URL in `SHEET_ID`. The seed script creates the `Contacts` and `Calls` tabs.
4. Vapi:
   - Run `cloudflared tunnel --url http://localhost:3000` and set `PUBLIC_URL` to the URL it prints.
   - In Vapi, buy a number. Leave **Assistant empty** and set the **Server URL** to `PUBLIC_URL/vapi`.
   - If you set `VAPI_SECRET`, also set the same secret on the number.

## How it works
| File | What |
|---|---|
| `src/config.ts` | Shop facts: hours, services, prices, policies. The agent only knows what's here. |
| `src/calendar.ts` | Availability, booking, lookup, reschedule, cancel, running late. Pure slot logic sits at the top. |
| `src/sheets.ts` | `Contacts` (one row per caller, upserted by phone) and `Calls` (one row per conversation). |
| `src/tools.ts` | A single list of tools. The schemas go to both Gemini and Vapi, and the handlers are shared. |
| `src/prompt.ts` | The system prompt, with a 14-day date table so the model never does date math. |
| `src/agent.ts` | The Gemini tool loop for chat. |
| `src/server.ts` | `/chat`, plus `/vapi` for `assistant-request`, `tool-calls`, and `end-of-call-report`. |

**Correctness choices**
- The model never decides on its own whether a slot is open. `book_appointment` re-checks the calendar right before inserting.
- A slot must fit inside business hours: it starts after opening and the service finishes by closing. It can't overlap any event (the shop has one bay), and it can't be in the past. If it fails, the agent offers the nearest open starts that day on a 30-minute grid.
- Bookings carry `phone` as a private extended property. Reschedule, cancel and running-late all verify that the event belongs to that phone number, so a wrong ID can't change someone else's booking.
- Phone numbers are normalized to `415-555-0190` everywhere.
- Tool errors go back to the model as data rather than crashing the turn.

**Handled by the agent:** booking, rescheduling, cancelling, prices, hours, prep, vehicle types, and running late. The slot is held for 15 minutes; later than that, the agent offers to reschedule.

**Handed off to a human** (logged with `Needs Human = TRUE`, owner calls back): charge disputes, refunds, damage claims, complaints about past work, custom quotes (ceramic, paint correction, RVs, boats, fleets), anything not in the config, and requests to talk to a person.

**Voice latency:** the Vapi config is built in [`src/server.ts`](src/server.ts).
- Gemini Flash with `maxTokens 150`.
- Deepgram nova-3 for transcription.
- Endpointing: `onPunctuation 0.1s`, plus a longer `onNumber 0.9s` so phone numbers don't get cut off.
- `waitSeconds 0.4`, and the caller can interrupt.
- While a tool runs, the agent says a filler line ("Let me check...").
- Caller ID goes into the prompt.
- The assistant is built for every call, so the date table is always current.

**Known limits:**
- Sessions are in memory.
- A check-then-insert race is possible if two people book the same slot within the same second. That's acceptable at about 30 calls a day.
