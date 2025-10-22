// api/handoff.js
import fetch from "node-fetch"; // only needed if you use Node <18 (optional on Vercel Node 18+)

const SHEETS_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbwz09aVni-6Bda5TywSPOF8aQhpiWTpHKwfeyYjqZxLTzkG0DL4C15hp81mnROaCrjisA/exec";
const SHEETS_WEBHOOK_TOKEN = process.env.SHEETS_WEBHOOK_TOKEN || "GT_CHATBOT_SECRET"; // optional security token

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { sessionId, name, email, phone, note } = req.body || {};
    if (!sessionId || !name || !email || !phone) {
      return res
        .status(400)
        .json({ error: "sessionId, name, email, and phone are required" });
    }

    // Send data to Google Sheets Web App
    const payload = {
      token: SHEETS_WEBHOOK_TOKEN, // same secret you set in Apps Script
      sessionId,
      name,
      email,
      phone,
      note: note || "",
    };

    const response = await fetch(SHEETS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error("❌ Google Sheets webhook error:", await response.text());
      return res.status(500).json({
        error: "Failed to send data to Google Sheets",
      });
    }

    console.log("✅ Lead successfully sent to Google Sheets:", {
      name,
      email,
      phone,
    });

    // Respond success to frontend
    return res.json({
      ok: true,
      message: "Handoff requested. Our counselor will contact you shortly.",
    });
  } catch (e) {
    console.error("handoff error:", e);
    return res.status(500).json({ error: "handoff failed" });
  }
}
