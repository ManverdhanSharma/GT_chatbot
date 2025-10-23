// api/handoff.js (temporary debug - returns full details)
const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL;
const SHEETS_WEBHOOK_TOKEN = process.env.SHEETS_WEBHOOK_TOKEN;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { sessionId, name, email, phone, note } = req.body || {};
    if (!sessionId || !name || !email || !phone) {
      return res.status(400).json({ error: "Missing required fields", required: ["sessionId","name","email","phone"] });
    }

    if (!SHEETS_WEBHOOK_URL) {
      return res.status(500).json({ error: "missing-env", details: "SHEETS_WEBHOOK_URL is not set in environment" });
    }
    if (!SHEETS_WEBHOOK_TOKEN) {
      return res.status(500).json({ error: "missing-env", details: "SHEETS_WEBHOOK_TOKEN is not set in environment" });
    }

    const payload = { token: SHEETS_WEBHOOK_TOKEN, sessionId, name, email, phone, note: note || "" };

    let response;
    try {
      response = await fetch(SHEETS_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (fetchErr) {
      // network / invalid URL / runtime fetch error
      return res.status(500).json({ error: "fetch-failed", details: String(fetchErr) });
    }

    const text = await response.text().catch(e => String(e));

    return res.status(200).json({
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      sheetResponseBody: text
    });

  } catch (e) {
    return res.status(500).json({ error: "function-crashed", details: String(e) });
  }
}
