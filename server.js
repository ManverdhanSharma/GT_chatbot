// server.js — GlobalTree concise & de-duplicated (paste over existing)
import express from "express";
import path from "path";
import fs from "fs/promises";
import bodyParser from "body-parser";
import cors from "cors";
import { fileURLToPath } from "url";
import 'dotenv/config';
import { GoogleGenerativeAI } from "@google/generative-ai";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8081;
const LEADS_FILE = path.resolve(__dirname, "leads.json");
const CONV_FILE = path.resolve(__dirname, "conversations.json");
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const RELIABLE_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

if (!GEMINI_API_KEY) {
  console.error("FATAL ERROR: GEMINI_API_KEY not found in environment variables.");
  process.exit(1);
}
const ai = new GoogleGenerativeAI(GEMINI_API_KEY);

/* ---------- STRICT SYSTEM INSTRUCTION (keeps model concise) ---------- */
const systemInstruction = `
You are GlobalTree's short-answer assistant. Always keep replies concise, factual, and action-oriented.
Prefer 3-6 bullets for list queries and max 3 numbered steps for process queries.
Do not ask multi-domain questions (no medical/business/legal prompts). If user asks for a consultation, ask only: name, email, phone.
`;

/* ---------- HELPERS ---------- */
async function ensureFile(file, initial = "[]") {
  try { await fs.access(file); } catch (e) { await fs.writeFile(file, initial, "utf8"); }
}
async function loadJson(file) {
  try { await ensureFile(file); const raw = await fs.readFile(file, "utf8"); return raw.trim() ? JSON.parse(raw) : []; } catch (e) { return []; }
}
async function saveJson(file, obj) {
  try { await fs.writeFile(file, JSON.stringify(obj, null, 2), "utf8"); return true; } catch (e) { console.error("Failed to save", file, e); return false; }
}
async function saveLead(lead) {
  const arr = await loadJson(LEADS_FILE); arr.push({ ...lead, createdAt: new Date().toISOString() }); return saveJson(LEADS_FILE, arr);
}
async function appendConversation(sessionId, entry) {
  const all = await loadJson(CONV_FILE); all.push({ sessionId, ts: new Date().toISOString(), ...entry }); return saveJson(CONV_FILE, all);
}
async function getLastAssistantReply(sessionId) {
  const all = await loadJson(CONV_FILE);
  for (let i = all.length - 1; i >= 0; --i) {
    if (all[i].sessionId === sessionId && all[i].role === "assistant") return all[i].content;
  }
  return null;
}

/* ---------- Simple intent checks & canned replies ---------- */
function isGreeting(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return /\b(hi|hello|hlo|hey|namaste|kaise ho|how are you)\b/.test(t);
}
function isTopUniversities(text) {
  if (!text) return false;
  return /\b(top universities|best universities|top colleges|top univ|universities in|best for)\b/i.test(text);
}
function isScholarships(text) {
  if (!text) return false;
  return /\b(scholarship|scholarships|funding|grants|financial aid)\b/i.test(text);
}
function isVisaProcess(text) {
  if (!text) return false;
  return /\b(visa process|visa|apply for visa|vfs|immigration)\b/i.test(text);
}
function isBookConsult(text) {
  if (!text) return false;
  return /\b(book|consult|consultation|book a consultation|request callback|request consult)\b/i.test(text);
}

/* Simple country detector for top univs (very small map) */
function detectCountry(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (t.includes("canada")) return "canada";
  if (t.includes("usa") || t.includes("united states") || t.includes("us")) return "usa";
  if (t.includes("uk") || t.includes("united kingdom") || t.includes("britain")) return "uk";
  if (t.includes("australia")) return "australia";
  if (t.includes("singapore")) return "singapore";
  if (t.includes("germany")) return "germany";
  return null;
}

/* canned lists */
const CANNED = {
  global_top: [
    "• Massachusetts Institute of Technology (MIT)",
    "• Stanford University",
    "• Harvard University",
    "• University of Cambridge",
    "• University of Oxford"
  ],
  canada: [
    "• University of Toronto",
    "• University of British Columbia",
    "• McGill University",
    "• University of Waterloo"
  ],
  usa: [
    "• MIT",
    "• Stanford University",
    "• Harvard University",
    "• UC Berkeley"
  ],
  uk: [
    "• University of Oxford",
    "• University of Cambridge",
    "• Imperial College London",
    "• UCL"
  ],
  australia: [
    "• University of Melbourne",
    "• University of Sydney",
    "• Australian National University (ANU)",
    "• UNSW Sydney"
  ],
  scholarships_short: [
    "• Government scholarships (e.g., Fulbright, Chevening, Australia Awards)",
    "• University-specific scholarships (merit/need-based)",
    "• Country-level entrance scholarships (provincial/state schemes)",
    "• External funding bodies and foundations"
  ],
  visa_process_short: [
    "1. Check visa category & eligibility on official consulate site.",
    "2. Prepare documents (passport, admission letter, financials, biometrics).",
    "3. Book appointment / pay fees / attend biometrics & wait for decision."
  ]
};

/* ---------- Robust extractor (keeps as before) ---------- */
function findFirstText(obj, opts = { minLen: 1 }) {
  const visited = new WeakSet();
  function isLikelyText(s) { return typeof s === "string" && s.trim().length >= (opts.minLen || 1); }
  function helper(value) {
    if (value == null) return null;
    if (typeof value === "string") return isLikelyText(value) ? value.trim() : null;
    if (typeof value !== "object") return null;
    if (visited.has(value)) return null;
    visited.add(value);
    if (Array.isArray(value)) { for (const it of value) { const r = helper(it); if (r) return r; } return null; }
    const preferKeys = ["text","content","outputText","output_text","message","candidates","choices","delta","output","response"];
    for (const k of preferKeys) if (k in value) { const r = helper(value[k]); if (r) return r; }
    for (const k of Object.keys(value)) { try { const r = helper(value[k]); if (r) return r; } catch (e) {} }
    return null;
  }
  return helper(obj);
}
function extractTextFromGeminiResponse(resp) {
  if (!resp) return null;
  if (typeof resp.text === "string" && resp.text.trim()) return resp.text.trim();
  if (typeof resp.outputText === "string" && resp.outputText.trim()) return resp.outputText.trim();
  const found = findFirstText(resp, { minLen: 8 });
  if (found) return found;
  const found2 = findFirstText(resp, { minLen: 1 });
  if (found2) return found2;
  return null;
}

/* ---------- Sanitiser: remove off-topic consultation categories & trim long replies ---------- */
function sanitizeReply(reply) {
  if (!reply) return reply;
  // remove obvious off-topic prompts (medical/legal/financial)
  const banned = /\b(medical|legal|financial|therapy|doctor|lawyer|business strategy)\b/ig;
  if (banned.test(reply)) {
    // replace with our booking prompt instead
    return "Great — to book a free consultation please share: 1) full name, 2) email, 3) phone number. A GlobalTree counselor will contact you within 24 hours.";
  }
  // shorten long replies to ~700 chars
  if (reply.length > 700) {
    // try to keep first few lines or sentences
    const lines = reply.split(/\n/).filter(Boolean);
    let out = lines.slice(0, 4).join("\n");
    if (out.length > 700) out = out.slice(0, 700);
    return out.trim() + "\n\nFor full details, please book a free consultation with GlobalTree.";
  }
  return reply.trim();
}

/* ---------- Chat endpoint with canned intent routing ---------- */
app.post("/api/chat", async (req, res) => {
  try {
    const { messages, sessionId: clientSession } = req.body || {};
    if (!messages || !Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: "messages array is required" });

    const sessionId = clientSession || crypto.randomBytes(8).toString("hex");
    const lastUserMessage = String(messages[messages.length - 1].content || "").trim();

    // If greeting and last assistant reply was also greeting, don't repeat — return short refocus
    if (isGreeting(lastUserMessage)) {
      const lastAssist = await getLastAssistantReply(sessionId);
      if (lastAssist && /globaltree/i.test(lastAssist)) {
        const short = "Namaste — I'm GlobalTree's assistant. How can I help with your study-abroad question?";
        await appendConversation(sessionId, { role: "assistant", content: short });
        return res.json({ message: { role: "assistant", content: short }, sessionId, meta: { intent: { intent: "greeting" }, leadSuggested: false } });
      }
      // else proceed normally (let the model or canned logic handle the first greeting)
    }

    // CANNED ROUTING for Top Universities / Scholarships / Visa / Book Consultation
    if (isTopUniversities(lastUserMessage)) {
      const country = detectCountry(lastUserMessage);
      const list = country ? (CANNED[country] || CANNED.global_top) : CANNED.global_top;
      const reply = list.join("\n") + "\n\n👉 For personalised help and eligibility checks, book a free consultation with GlobalTree (we'll need name, email, phone).";
      await appendConversation(sessionId, { role: "assistant", content: reply });
      return res.json({ message: { role: "assistant", content: reply }, sessionId, meta: { intent: { intent: "top_universities", score: 1 }, leadSuggested: false } });
    }

    if (isScholarships(lastUserMessage)) {
      const reply = CANNED.scholarships_short.join("\n") + "\n\n👉 For personalised scholarship matching and deadlines, book a free consultation with GlobalTree (name, email, phone).";
      await appendConversation(sessionId, { role: "assistant", content: reply });
      return res.json({ message: { role: "assistant", content: reply }, sessionId, meta: { intent: { intent: "scholarships", score: 1 }, leadSuggested: false } });
    }

    if (isVisaProcess(lastUserMessage)) {
      const reply = CANNED.visa_process_short.join("\n") + "\n\n👉 For a step-by-step application checklist and timeline, book a free consultation with GlobalTree (name, email, phone).";
      await appendConversation(sessionId, { role: "assistant", content: reply });
      return res.json({ message: { role: "assistant", content: reply }, sessionId, meta: { intent: { intent: "visa", score: 1 }, leadSuggested: true } });
    }

    if (isBookConsult(lastUserMessage)) {
      const bookingPrompt = "Great — to book a free consultation please share: 1) full name, 2) email, 3) phone number. A GlobalTree counselor will contact you within 24 hours.";
      await appendConversation(sessionId, { role: "assistant", content: bookingPrompt });
      return res.json({ message: { role: "assistant", content: bookingPrompt }, sessionId, meta: { intent: { intent: "lead", score: 1 }, leadSuggested: true } });
    }

    // Otherwise call Gemini but sanitize output and dedupe
    const history = messages.slice(0, -1).map(msg => ({ role: msg.role === "assistant" ? "model" : "user", parts: [{ text: String(msg.content) }] }));
    const geminiChat = ai.getGenerativeModel({ model: RELIABLE_MODEL, config: { systemInstruction, responseModalities: ["TEXT"] } }).startChat({ history });
    let response = await geminiChat.sendMessage(lastUserMessage);

    // extract and sanitize
    let reply = extractTextFromGeminiResponse(response) || "";
    reply = sanitizeReply(reply);

    // server override for lead-like but ensure concise booking prompt
    const intent = detectIntent(lastUserMessage || "");
    if ((intent.intent === "lead" || (intent.intent === "visa" && intent.score >= 0.8))) {
      const bookingPrompt = "Great — to book a free consultation please share: 1) full name, 2) email, 3) phone number. A GlobalTree counselor will contact you within 24 hours.";
      // if reply already asks for those fields, keep short; otherwise set bookingPrompt
      const lower = reply.toLowerCase();
      const asksForFields = lower.includes("name") && lower.includes("email") && lower.includes("phone");
      if (!asksForFields) reply = bookingPrompt;
      else reply = reply.split("\n").slice(0, 6).join("\n") + "\n\n" + bookingPrompt;
    }

    // Prevent duplicate assistant replies in conversation store
    const lastAssist = await getLastAssistantReply(sessionId);
    if (lastAssist && lastAssist.trim() === reply.trim()) {
      // avoid repeating exactly same message — acknowledge briefly instead
      const ack = "I've already shared that — would you like help booking a consultation?";
      await appendConversation(sessionId, { role: "assistant", content: ack });
      return res.json({ message: { role: "assistant", content: ack }, sessionId, meta: { intent, leadSuggested: intent.intent === "lead" } });
    }

    await appendConversation(sessionId, { role: "assistant", content: reply });
    return res.json({ message: { role: "assistant", content: reply }, sessionId, meta: { intent, leadSuggested: intent.intent === "lead" || intent.intent === "visa" } });

  } catch (err) {
    console.error("Chat error:", err);
    return res.status(500).json({ message: { role: "assistant", content: "Sorry, I'm having trouble connecting to the service." }, error: "internal" });
  }
});

/* ---------- HANDOFF ---------- */
app.post("/api/handoff", async (req, res) => {
  try {
    const { sessionId, name, email, phone, note } = req.body || {};
    if (!sessionId || !name || !email || !phone) return res.status(400).json({ error: "sessionId, name, email, phone required" });
    await saveLead({ name, email, phone, note: note || `Handoff from session ${sessionId}`, source: "widget-handoff" });
    await appendConversation(sessionId, { role: "system", content: `Handoff requested: ${name} ${email} ${phone}` });
    return res.json({ ok: true, message: "Handoff requested. Our counselor will contact you shortly." });
  } catch (e) {
    console.error("Handoff error:", e);
    return res.status(500).json({ error: "handoff failed" });
  }
});

/* ---------- DEV ---------- */
app.get("/health", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get("/api/conversations", async (req, res) => {
  const { sessionId } = req.query; if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  const all = await loadJson(CONV_FILE); const filtered = all.filter(c => c.sessionId === sessionId); return res.json({ sessionId, entries: filtered });
});

/* ---------- START ---------- */
app.listen(PORT, () => {
  console.log(`GlobalTree server listening on port ${PORT}`);
  console.log(`Open http://localhost:${PORT}/chatbot_widget.html`);
});
