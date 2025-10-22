// api/handoff.js
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LEADS_FILE = path.resolve(__dirname, "../leads.json");

async function ensureFile(file, initial = "[]") {
  try { await fs.access(file); } catch (e) { await fs.writeFile(file, initial, "utf8"); }
}
async function loadJson(file) {
  try { await ensureFile(file); const raw = await fs.readFile(file, "utf8"); return raw.trim() ? JSON.parse(raw) : []; } catch (e) { return []; }
}
async function saveJson(file, obj) {
  try { await fs.writeFile(file, JSON.stringify(obj, null, 2), "utf8"); return true; } catch (e) { return false; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { sessionId, name, email, phone, note } = req.body || {};
    if (!sessionId || !name || !email || !phone) return res.status(400).json({ error: "sessionId, name, email, phone required" });

    const leads = await loadJson(LEADS_FILE);
    leads.push({ sessionId, name, email, phone, note: note || "", createdAt: new Date().toISOString() });
    await saveJson(LEADS_FILE, leads);

    // In prod: send email/sms/CRM webhook here
    return res.json({ ok: true, message: "Handoff requested. Our counselor will contact you shortly." });
  } catch (e) {
    console.error("handoff error:", e);
    return res.status(500).json({ error: "handoff failed" });
  }
}
