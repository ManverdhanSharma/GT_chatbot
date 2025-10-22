// api/chat.js
import { GoogleGenerativeAI } from "@google/generative-ai";
import crypto from "crypto";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const RELIABLE_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const SYSTEM_INSTRUCTION = process.env.SYSTEM_INSTRUCTION || `You are GlobalTree's short-answer assistant. Keep replies concise, factual, and action-oriented. For list queries give bullets (3-6 items). For consultations ask only name, email, phone.`;

if (!GEMINI_API_KEY) {
  console.error("Warning: GEMINI_API_KEY not set in environment.");
}

const ai = new GoogleGenerativeAI(GEMINI_API_KEY);

// Local files (ephemeral on Vercel)
const CONV_FILE = path.resolve(__dirname, "../conversations.json");

async function ensureFile(file, initial = "[]") {
  try { await fs.access(file); } catch (e) { await fs.writeFile(file, initial, "utf8"); }
}
async function loadJson(file) {
  try { await ensureFile(file); const s = await fs.readFile(file, "utf8"); return s.trim() ? JSON.parse(s) : []; } catch (e) { return []; }
}
async function appendConversation(sessionId, entry) {
  try {
    const all = await loadJson(CONV_FILE);
    all.push({ sessionId, ts: new Date().toISOString(), ...entry });
    await fs.writeFile(CONV_FILE, JSON.stringify(all, null, 2), "utf8");
  } catch (e) { /* ignore write errors on serverless */ }
}

function detectIntent(text) {
  if (!text) return { intent: "unknown", score: 0 };
  const t = text.toLowerCase();
  if (/\b(book|consult|consultation|request callback|request consult)\b/.test(t)) return { intent: "lead", score: 0.95 };
  if (/\b(visa|vfs|immigration|apply for visa)\b/.test(t)) return { intent: "visa", score: 0.9 };
  return { intent: "general", score: 0.3 };
}

const CANNED = {
  global_top: [
    "• MIT",
    "• Stanford University",
    "• Harvard University",
    "• University of Cambridge",
    "• University of Oxford"
  ],
  scholarships_short: [
    "• Government scholarships (Fulbright, Chevening, Australia Awards)",
    "• University scholarships (merit/need-based)",
    "• External foundations and trusts"
  ],
  visa_process_short: [
    "1. Check visa category & eligibility on official consulate site.",
    "2. Prepare documents (admission letter, passport, financial proof, biometrics).",
    "3. Book appointment, pay fees, attend biometrics & wait for decision."
  ]
};

function isTopUniversities(text) {
  if (!text) return false;
  return /\b(top universities|best universities|top colleges|top univ|universities in)\b/i.test(text);
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

/* Gemini extractor — robust */
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

function sanitizeReply(reply) {
  if (!reply) return reply;
  const banned = /\b(medical|legal|financial|therapy|doctor|lawyer|business strategy)\b/ig;
  if (banned.test(reply)) return "Great — to book a free consultation please share: 1) full name, 2) email, 3) phone number.";
  if (reply.length > 700) return reply.slice(0, 700) + "\n\nFor full details, please book a free consultation with GlobalTree.";
  return reply.trim();
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { messages, sessionId: clientSession } = req.body || {};
    if (!messages || !Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: "messages array required" });

    const sessionId = clientSession || crypto.randomBytes(8).toString("hex");
    const lastUserMessage = String(messages[messages.length - 1].content || "").trim();

    // Canned short routes (no model call)
    if (isTopUniversities(lastUserMessage)) {
      const reply = CANNED.global_top.slice(0,5).join("\n") + "\n\n👉 For personalised help, book a free consultation (name, email, phone).";
      await appendConversation(sessionId, { role: "assistant", content: reply });
      return res.json({ message: { role: "assistant", content: reply }, sessionId, meta: { intent: { intent: "top_universities", score: 1 } } });
    }
    if (isScholarships(lastUserMessage)) {
      const reply = CANNED.scholarships_short.join("\n") + "\n\n👉 For scholarship matching, book a free consultation (name, email, phone).";
      await appendConversation(sessionId, { role: "assistant", content: reply });
      return res.json({ message: { role: "assistant", content: reply }, sessionId, meta: { intent: { intent: "scholarships", score: 1 } } });
    }
    if (isVisaProcess(lastUserMessage)) {
      const reply = CANNED.visa_process_short.join("\n") + "\n\n👉 For a step-by-step checklist, book a free consultation (name, email, phone).";
      await appendConversation(sessionId, { role: "assistant", content: reply });
      return res.json({ message: { role: "assistant", content: reply }, sessionId, meta: { intent: { intent: "visa", score: 1 }, leadSuggested: true } });
    }
    if (isBookConsult(lastUserMessage)) {
      const bookingPrompt = "Great — to book a free consultation please share: 1) full name, 2) email, 3) phone number. A GlobalTree counselor will contact you within 24 hours.";
      await appendConversation(sessionId, { role: "assistant", content: bookingPrompt });
      return res.json({ message: { role: "assistant", content: bookingPrompt }, sessionId, meta: { intent: { intent: "lead", score: 1 }, leadSuggested: true } });
    }

    // Fallback — call Gemini
    const history = messages.slice(0, -1).map(msg => ({ role: msg.role === "assistant" ? "model" : "user", parts: [{ text: String(msg.content) }] }));
    const geminiChat = ai.getGenerativeModel({ model: RELIABLE_MODEL, config: { systemInstruction: SYSTEM_INSTRUCTION, responseModalities: ["TEXT"] } }).startChat({ history });
    let response = await geminiChat.sendMessage(lastUserMessage);
    let reply = extractTextFromGeminiResponse(response) || "";
    reply = sanitizeReply(reply);

    await appendConversation(sessionId, { role: "assistant", content: reply });
    return res.json({ message: { role: "assistant", content: reply }, sessionId, meta: { intent: detectIntent(lastUserMessage) } });

  } catch (err) {
    console.error("chat error:", err);
    return res.status(500).json({ error: "internal" });
  }
}
