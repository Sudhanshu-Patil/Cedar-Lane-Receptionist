import { Content, GoogleGenAI, Part } from "@google/genai";
import { buildSystemPrompt } from "./prompt.js";
import { runTool, TOOLS } from "./tools.js";

// SDK default is 5 retries with up to 60s backoff: a busy model looked like a 7-minute hang. Fail fast instead.
const httpOptions = { timeout: 30_000, retryOptions: { attempts: 3, maxDelay: 2 } };

// Vertex AI (billed to a GCP project via service account) if configured, else a plain Gemini API key.
const ai = process.env.VERTEX_PROJECT
  ? new GoogleGenAI({
      vertexai: true,
      project: process.env.VERTEX_PROJECT,
      location: process.env.VERTEX_LOCATION || "us-central1",
      googleAuthOptions: { keyFile: process.env.VERTEX_SA_KEY, scopes: ["https://www.googleapis.com/auth/cloud-platform"] },
      httpOptions,
    })
  : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions });
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const functionDeclarations = TOOLS.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters }));

// ponytail: in-memory sessions, lost on restart. Fine for a demo; Redis if this runs for real.
const sessions = new Map<string, Content[]>();

export async function chat(sessionId: string, message: string): Promise<string> {
  const history = sessions.get(sessionId) ?? [];
  sessions.set(sessionId, history);
  const turnStart = history.length;
  history.push({ role: "user", parts: [{ text: message }] });

  let nudge = false;
  for (let step = 0; step < 6; step++) {
    const res = await ai.models.generateContent({
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

    // Gemini quirk: after a tool result it sometimes ends the turn with no text. Don't keep that turn; ask again.
    if (!calls.length && !text) {
      console.warn("[agent] empty model turn, retrying");
      nudge = true;
      continue;
    }
    nudge = false;
    if (content) history.push(content); // keep the model turn verbatim (thought signatures included)
    if (!calls.length) return text!;

    const parts: Part[] = await Promise.all(calls.map(async (c) => ({
      functionResponse: { id: c.id, name: c.name, response: { result: await runTool(c.name!, c.args, { channel: "chat" }) } },
    })));
    history.push({ role: "user", parts });
  }
  return "Sorry, I'm having trouble with that. Let me have someone from the shop call you back.";
}
