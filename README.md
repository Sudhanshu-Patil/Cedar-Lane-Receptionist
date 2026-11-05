# Cedar Lane Auto Detailing: AI Receptionist

A TypeScript AI receptionist. It books appointments in Google Calendar and logs callers to Google Sheets.
- **Phase 1** is a text chat, using a Gemini function-calling loop.
- **Phase 2** is a phone line on Vapi. It shares the same prompt, tools and handlers; only the voice model differs (see Voice latency).

## Demo videos
- Phase 1 (chat + Calendar + Sheet): https://drive.google.com/file/d/1todXohpV7nNXUIgT9Hr4oTSzYCYMg6VO/view
- Phase 2 (real phone call via Vapi): https://drive.google.com/file/d/1ZmsE1UJmPs0Io7qPFsGfqDrgnU2P4NZH/view
- Product demo, 23s (one call from ring to calendar to log). Click the preview for the full video with sound:

[![Cedar Lane AI receptionist demo](brag-output/brag.gif)](brag-output/brag.mp4)

## Website
`npm start` also serves a site for the shop at `/`. It puts the same agent in front of customers three ways:
- **Call:** the Vapi phone number.
- **Chat:** a widget that talks to `/chat`.
- **Talk in your browser:** a Vapi web call to the same assistant as the phone line.

Prices and hours come from `config.ts` through `GET /api/shop`, so the site and the agent always agree. For browser calls, `POST /api/voice` refreshes the saved assistant and returns only the public key and assistant ID, so the webhook secret never reaches the browser. The plain chat page from Phase 1 is still at `/chat.html`. With `DEMO_RESET=1` (set in `render.yaml`), the server resets the calendar to the seed week once a day after 3 AM shop time (`src/demo.ts`), so visitors' test bookings don't pile up and "Thursday 3:30 is full" always holds for the coming Thursday. Photos and video are from Unsplash and Mixkit (see `public/CREDITS.md`).

## Run
```bash
npm i
cp .env.example .env              # fill in the keys (see Setup)
npm run seed                      # reset the calendar to the seed week + sheet tabs/headers
npm run check                     # offline asserts for the slot logic
npm start                         # http://localhost:3000
npm run vapi                      # sync the Vapi assistant + phone number to PUBLIC_URL
```

## Setup
1. Google Cloud: enable the **Calendar API** and the **Sheets API**. Create a **service account** and download its JSON key to `./service-account.json`.
2. Create a new Google Calendar. In its settings, share it with the service account's `client_email` ("Make changes to events"). Put the calendar ID in `CALENDAR_ID`.
3. Create a Google Sheet and share it with the same email as Editor. Put the sheet ID from its URL in `SHEET_ID`. The seed script creates the `Contacts` and `Calls` tabs.
4. Gemini (chat): set `GEMINI_API_KEY`. Alternatively, set `VERTEX_PROJECT` and `VERTEX_SA_KEY` to bill a GCP project through Vertex AI.
5. Vapi:
   - Run `cloudflared tunnel --url http://localhost:3000` and set `PUBLIC_URL` to the URL it prints.
   - Set `VAPI_SECRET` to any random string, and set `VAPI_API_KEY` to your Vapi private key. For the website's browser calls, also set `VAPI_PUBLIC_KEY`.
   - Create a free Vapi number, then run `npm run vapi`. It points the number at `PUBLIC_URL/vapi` (no fixed assistant) and saves a copy of the assistant for the dashboard's "Talk" button. Re-run it whenever the tunnel URL changes.

## How it works
| File | What |
|---|---|
| `src/config.ts` | Shop facts: hours, services, prices, policies. The agent only knows what's here. |
| `src/calendar.ts` | Availability, booking, lookup, reschedule, cancel, running late. Pure slot logic sits at the top. |
| `src/sheets.ts` | `Contacts` (one row per caller, upserted by phone) and `Calls` (one row per conversation). |
| `src/tools.ts` | A single list of tools. The schemas go to both Gemini and Vapi, and the handlers are shared. |
| `src/prompt.ts` | The system prompt, with a 14-day date table so the model never does date math. |
| `src/agent.ts` | The Gemini tool loop for chat. It retries Gemini's occasional empty turn after a tool result, and rolls back a failed turn. |
| `src/vapi.ts` | The Vapi assistant config, built per call from the same prompt and tools. |
| `src/server.ts` | `/chat`, plus `/vapi` for `assistant-request`, `tool-calls`, and `end-of-call-report`. Also `/api/shop` and `/api/voice` for the website. |
| `public/` | The shop website (`index.html`, `app.js`, `styles.css`) and the Phase 1 chat page (`chat.html`). |
| `scripts/` | `seed.ts` (test data), `check.ts` (offline asserts), `vapi-assistant.ts` (Vapi sync). |

**Correctness choices**
- The model never decides on its own whether a slot is open. `book_appointment` re-checks the calendar right before inserting.
- A slot must fit inside business hours: it starts after opening and the service finishes by closing. It can't overlap any event (the shop has one bay), and it can't be in the past. If it fails, the agent offers the nearest open starts that day on a 30-minute grid.
- Bookings carry `phone` as a private extended property. Reschedule, cancel and running-late all verify that the event belongs to that phone number, so a wrong ID can't change someone else's booking.
- **Phone numbers:** the model passes the digits as heard ("4 1 5 5 5 5 o 1 90"), and the code normalizes them to `415-555-0190`. Anything that isn't 10 digits is rejected, never guessed. Letting the model retype digits added an extra 5 in testing.
- **Running late** only applies to a booking today. This is enforced in code, not just in the prompt.
- **Tool errors** go back to the model as data rather than crashing the turn.
- **Call logging:**
  - In chat, the agent calls `log_call` when the caller wraps up.
  - On voice, the server writes the `Calls` row from Vapi's end-of-call report. That row combines Vapi's structured analysis with facts collected from the tool calls, so a hang-up still gets logged. Asking the voice model to call a tool at goodbye made it go silent.

**Handled by the agent:** booking, rescheduling, cancelling, prices, hours, prep, vehicle types, and running late. The slot is held for 15 minutes; later than that, the agent offers to reschedule.

**Handed off to a human** (logged with `Needs Human = TRUE`, owner calls back): charge disputes, refunds, damage claims, complaints about past work, custom quotes (ceramic, paint correction, RVs, boats, fleets), anything not in the config, and requests to talk to a person.

**Voice latency:** the Vapi config is built in [`src/vapi.ts`](src/vapi.ts). The settings, and why:
- **LLM: `gpt-4.1-mini` with `maxTokens 150`.**
  - Measured on Vapi, Gemini took 2.6–9.8 s per turn (Google capacity issues), while gpt-4.1-mini took about 200–350 ms.
  - The last test call averaged **1.17 s per turn** from the caller stopping to the agent speaking, tool turns included.
  - Chat stays on Gemini.
- **Transcription:** Deepgram nova-3.
- **Endpointing:** `onPunctuation 0.1s`, plus a longer `onNumber 0.9s` so phone numbers don't get cut off. `waitSeconds 0.4`, and the caller can interrupt.
- **Filler lines while a tool runs** ("Let me check..."), so there's no dead air during a calendar lookup.
- **Read-back:** the agent confirms the name and number before booking, because speech-to-text misheard "Sara" as "Vesara" and "Zara".
- **Hang-up:** `endCallPhrases: ["have a great day"]` makes the hang-up deterministic. The model didn't reliably call `endCall` on its own.
- **Per-call assistant:** the assistant is built for every call (`assistant-request`), so the date table is always current and the caller ID goes into the prompt.

**Known limits:**
- Sessions and per-call state are kept in memory.
- A check-then-insert race is possible if two people book the same slot within the same second. That's acceptable at about 30 calls a day.
- The quick tunnel's URL changes when it restarts or the laptop sleeps, so `npm run vapi` has to be re-run.
- The Vapi dashboard's Talk button sends the browser tab's cached copy of the assistant. Hard-refresh the dashboard after syncing. Real phone calls aren't affected, because each one fetches its assistant from the server.

## What I'd do next
- Host the server permanently (Render, Fly) instead of a quick tunnel, so the webhook URL never changes.
- On phone calls, default to the caller-ID number ("Is the number you're calling from best?") instead of asking for one.
- Make booking atomic (lock or idempotency key), and give each bay its own calendar if the shop adds capacity.
- Transfer the call live to the owner for handoffs during business hours, instead of only promising a callback.
