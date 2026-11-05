import { Content, GoogleGenAI, Part } from "@google/genai";
import { buildSystemPrompt } from "./prompt.js";
import { runTool, TOOLS } from "./tools.js";

// SDK default is 5 retries with up to 60s backoff; fail fast instead.
const httpOptions = { timeout: 30_000, retryOptions: { attempts: 3, maxDelay: 2 } };

const GROQ_KEY = process.env.GROQ_API_KEY;

// Vertex AI (billed to a GCP project via service account) if configured, else a plain Gemini API key.
// Only built when Groq isn't in use, so a Groq-only deploy needs no Google AI credentials.
const ai = GROQ_KEY ? null : process.env.VERTEX_PROJECT
  ? new GoogleGenAI({
      vertexai: true,
      project: process.env.VERTEX_PROJECT,
      location: process.env.VERTEX_LOCATION || "us-central1",
      googleAuthOptions: { keyFile: process.env.VERTEX_SA_KEY, scopes: ["https://www.googleapis.com/auth/cloud-platform"] },
      httpOptions,
    })
  : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions });
const MODEL = "gemini-2.5-flash";
const functionDeclarations = TOOLS.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters }));

// In-memory sessions, lost on restart.
const sessions = new Map<string, Content[]>();

const FALLBACK = "Sorry, I'm having trouble with that. Let me have someone from the shop call you back.";

export function chat(sessionId: string, message: string): Promise<string> {
  return GROQ_KEY ? chatGroq(sessionId, message) : chatGemini(sessionId, message);
}

async function chatGemini(sessionId: string, message: string): Promise<string> {
  const history = sessions.get(sessionId) ?? [];
  sessions.set(sessionId, history);
  const turnStart = history.length;
  history.push({ role: "user", parts: [{ text: message }] });

  let nudge = false;
  for (let step = 0; step < 6; step++) {
    const res = await ai!.models.generateContent({
      model: MODEL,
      // nudge is sent once but never stored in history
      contents: nudge ? [...history, { role: "user", parts: [{ text: "(Now reply to the customer.)" }] }] : history,
      config: { systemInstruction: buildSystemPrompt("chat"), tools: [{ functionDeclarations }], temperature: 0.2 },
    }).catch((e) => {
      history.length = turnStart; // drop the failed turn so the next message starts clean
      throw e;
    });
    const content = res.candidates?.[0]?.content;
    const calls = res.functionCalls ?? [];
    // read text parts ourselves (res.text warns when the turn also has function calls); skip thought summaries
    const text = content?.parts?.filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();

    // Gemini sometimes returns an empty turn after a tool result. Drop it and ask again.
    if (!calls.length && !text) {
      console.warn("[agent] empty model turn, retrying");
      nudge = true;
      continue;
    }
    nudge = false;
    if (content) history.push(content); // keep the model turn verbatim (thought signatures included)
    if (!calls.length) return text!;

    const parts: Part[] = await Promise.all(calls.map(async (c) => ({
      functionResponse: { id: c.id, name: c.name, response: { result: await runTool(c.name!, c.args, "chat") } },
    })));
    history.push({ role: "user", parts });
  }
  return FALLBACK;
}

// ---------- Groq (OpenAI-compatible API), used when GROQ_API_KEY is set ----------
const GROQ_MODEL = "llama-3.3-70b-versatile";
const groqTools = TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
type Msg = { role: "user" | "assistant" | "tool"; content: string | null; tool_calls?: any[]; tool_call_id?: string };
const groqSessions = new Map<string, Msg[]>();

async function chatGroq(sessionId: string, message: string): Promise<string> {
  const history = groqSessions.get(sessionId) ?? [];
  groqSessions.set(sessionId, history);
  const turnStart = history.length;
  history.push({ role: "user", content: message });
  try {
    for (let step = 0; step < 6; step++) {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${GROQ_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: GROQ_MODEL, temperature: 0.2, tools: groqTools, messages: [{ role: "system", content: buildSystemPrompt("chat") }, ...history] }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const body = await res.text();
        // Llama occasionally emits a malformed tool call; Groq rejects it with tool_use_failed. Just ask again.
        if (res.status === 400 && body.includes("tool_use_failed")) {
          console.warn("[agent] groq tool_use_failed, retrying");
          continue;
        }
        throw new Error(`groq ${res.status}: ${body.slice(0, 300)}`);
      }
      const msg = (await res.json()).choices[0].message;
      history.push({ role: "assistant", content: msg.content ?? null, ...(msg.tool_calls?.length && { tool_calls: msg.tool_calls }) });
      if (!msg.tool_calls?.length) return msg.content?.trim() || FALLBACK;
      for (const c of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(c.function.arguments || "{}"); } catch {}
        history.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(await runTool(c.function.name, args, "chat")) });
      }
    }
  } catch (e) {
    history.length = turnStart; // drop the failed turn so the next message starts clean
    throw e;
  }
  return FALLBACK;
}
