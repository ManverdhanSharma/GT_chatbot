// api/handoff.js (DEBUG version - temporary)
const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL || "https://script.google.com/macros/s/AKfycbwz09aVni-6Bda5TywSPOF8aQhpiWTpHKwfeyYjqZxLTzkG0DL4C15hp81mnROaCrjisA/exec";
const SHEETS_WEBHOOK_TOKEN = process.env.SHEETS_WEBHOOK_TOKEN || "GT_CHATBOT_SECRET";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { sessionId, name, email, phone, note } = req.body || {};
    if (!sessionId || !name || !email || !phone) return res.status(400).json({ error: "sessionId, name, email, phone required" });

    const payload = { token: SHEETS_WEBHOOK_TOKEN, sessionId, name, email, phone, note: note || "" };

    // call Apps Script webhook
    const r = await fetch(SHEETS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await r.text(); // raw response body (may be JSON, HTML, or error text)

    // Return full details so we can inspect in browser / logs
    return res.status(200).json({
      ok: r.ok,
      status: r.status,
      statusText: r.statusText,
      body: text
    });

  } catch (err) {
    console.error("handoff debug error:", err);
    return res.status(500).json({ error: String(err) });
  }
}
