// server.js — GlobalTree concise & de-duplicated (full file)
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

/* ---------- Robust extractor ---------- */
function findFirstText(obj, opts = { minLen: 1 }) {
  const visited = new WeakSet();
  function isLikelyText(s) { return typeof s === "string" && s.trim().length >= (opts.minLen || 1); }
  function helper(value) {
    if (value == null) return null;
    if (typeof value === "string") return isLikelyText(value) ? value.trim() : null;
    if (typeof value !== "object") return null;
    if (visited.has(value)) return null;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const it of value) { const r = helper(it); if (r) return r; }
      return null;
    }
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
    const lines = reply.split(/\n/).filter(Boolean);
    let out = lines.slice(0, 4).join("\n");
    if (out.length > 700) out = out.slice(0, 700);
    return out.trim() + "\n\nFor full details, please book a free consultation with GlobalTree.";
  }
  return reply.trim();
}

/* ---------- RATE LIMITER (basic) ---------- */
const rateMap = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'local';
  const now = Date.now();
  const bucket = rateMap.get(ip) || { count: 0, ts: now };
  if (now - bucket.ts > 60000) { bucket.count = 0; bucket.ts = now; }
  bucket.count += 1;
  rateMap.set(ip, bucket);
  if (bucket.count > 240) return res.status(429).json({ error: "Rate limit exceeded" });
  next();
}
app.use(rateLimit);
app.use(cors());
app.use(bodyParser.json({ limit: "2mb" }));
app.use(express.static(path.resolve(__dirname)));

/* ---------- CHAT ENDPOINT (FORCE CANNED SHORT REPLIES FOR COMMON INTENTS) ---------- */
app.post("/api/chat", async (req, res) => {
  try {
    const { messages, sessionId: clientSession } = req.body || {};
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array is required" });
    }

    const sessionId = clientSession || crypto.randomBytes(8).toString("hex");
    const lastUserMessage = String(messages[messages.length - 1].content || "").trim();

    // 1) GREETING: respond once per session with a short refocus message
    if (isGreeting(lastUserMessage)) {
      const lastAssist = await getLastAssistantReply(sessionId);
      const short = "Namaste — I'm GlobalTree's assistant. How can I help with your study-abroad question?";
      if (!lastAssist || !/globaltree/i.test(lastAssist)) {
        await appendConversation(sessionId, { role: "assistant", content: short });
        return res.json({ message: { role: "assistant", content: short }, sessionId, meta: { intent: { intent: "greeting" }, leadSuggested: false } });
      }
      // if greeted before, return a tiny acknowledgment (no model)
      const ack = "I've already greeted you — how can I help with your study-abroad question?";
      return res.json({ message: { role: "assistant", content: ack }, sessionId, meta: { intent: { intent: "greeting_repeat" }, leadSuggested: false } });
    }

    // 2) TOP UNIVERSITIES: canned short lists (no model)
    if (isTopUniversities(lastUserMessage)) {
      const country = detectCountry(lastUserMessage);
      const list = country ? (CANNED[country] || CANNED.global_top) : CANNED.global_top;
      const reply = list.slice(0, 6).join("\n") + "\n\n👉 For personalised help and eligibility checks, book a free consultation with GlobalTree (name, email, phone).";
      await appendConversation(sessionId, { role: "assistant", content: reply });
      return res.json({ message: { role: "assistant", content: reply }, sessionId, meta: { intent: { intent: "top_universities", score: 1 }, leadSuggested: false } });
    }

    // 3) SCHOLARSHIPS: canned short list
    if (isScholarships(lastUserMessage)) {
      const reply = CANNED.scholarships_short.slice(0,6).join("\n") + "\n\n👉 For scholarship matching, book a free consultation with GlobalTree (name, email, phone).";
      await appendConversation(sessionId, { role: "assistant", content: reply });
      return res.json({ message: { role: "assistant", content: reply }, sessionId, meta: { intent: { intent: "scholarships", score: 1 }, leadSuggested: false } });
    }

    // 4) VISA PROCESS: canned steps
    if (isVisaProcess(lastUserMessage)) {
      const reply = CANNED.visa_process_short.join("\n") + "\n\n👉 For a step-by-step checklist, book a free consultation with GlobalTree (name, email, phone).";
      await appendConversation(sessionId, { role: "assistant", content: reply });
      return res.json({ message: { role: "assistant", content: reply }, sessionId, meta: { intent: { intent: "visa", score: 1 }, leadSuggested: true } });
    }

    // 5) BOOK CONSULTATION: server enforces concise booking prompt
    if (isBookConsult(lastUserMessage)) {
      const bookingPrompt = "Great — to book a free consultation please share: 1) full name, 2) email, 3) phone number. A GlobalTree counselor will contact you within 24 hours.";
      await appendConversation(sessionId, { role: "assistant", content: bookingPrompt });
      return res.json({ message: { role: "assistant", content: bookingPrompt }, sessionId, meta: { intent: { intent: "lead", score: 1 }, leadSuggested: true } });
    }

    // 6) FALLBACK: call Gemini for anything else, but sanitize and trim its reply
    const history = messages.slice(0, -1).map(msg => ({ role: msg.role === "assistant" ? "model" : "user", parts: [{ text: String(msg.content) }] }));
    const geminiChat = ai.getGenerativeModel({ model: RELIABLE_MODEL, config: { systemInstruction, responseModalities: ["TEXT"] } }).startChat({ history });
    let response = await geminiChat.sendMessage(lastUserMessage);
    let reply = extractTextFromGeminiResponse(response) || "";
    reply = sanitizeReply(reply);

    // Prevent duplicate assistant replies
    const lastAssist = await getLastAssistantReply(sessionId);
    if (lastAssist && lastAssist.trim() === reply.trim()) {
      const ack = "I've already shared that — would you like help booking a consultation?";
      await appendConversation(sessionId, { role: "assistant", content: ack });
      return res.json({ message: { role: "assistant", content: ack }, sessionId, meta: { intent: detectIntent(lastUserMessage), leadSuggested: false } });
    }

    await appendConversation(sessionId, { role: "assistant", content: reply });
    return res.json({ message: { role: "assistant", content: reply }, sessionId, meta: { intent: detectIntent(lastUserMessage) } });

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
