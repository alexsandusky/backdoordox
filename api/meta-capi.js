// /api/meta-capi.js  — Vercel Serverless Function (plain JS)
// Handles Jotform webhook (multipart/form-data), parses rawRequest JSON,
// maps fields, hashes PII, and sends a Meta CAPI "Lead" event.

const crypto = require("crypto");
const { parse: parseQS } = require("querystring");

function sha256(v) {
  if (!v) return undefined;
  const s = String(v).trim().toLowerCase();
  return crypto.createHash("sha256").update(s).digest("hex");
}
const now = () => Math.floor(Date.now() / 1000);

// Read any body type: JSON, x-www-form-urlencoded, or multipart/form-data (Jotform)
async function readBody(req) {
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const raw = Buffer.concat(chunks).toString("utf8");
  const ct = String(req.headers["content-type"] || "");

  if (ct.includes("application/json")) return raw ? JSON.parse(raw) : {};
  if (ct.includes("application/x-www-form-urlencoded")) return parseQS(raw);

  // Jotform sends multipart/form-data and embeds a JSON blob in a part named "rawRequest"
  if (ct.includes("multipart/form-data")) {
    const m = raw.match(/name="rawRequest"\r\n\r\n([\s\S]*?)\r\n--/);
    if (m && m[1]) {
      try {
        const rr = JSON.parse(m[1]);
        // Try to derive formID from slug `submit/<id>`
        const formID = rr?.slug?.split("/")?.pop();
        return { rawRequest: rr, formID };
      } catch (e) {
        return { _multipart: raw };
      }
    }
    return { _multipart: raw };
  }

  // Fallback attempts
  try { return JSON.parse(raw); } catch { return parseQS(raw); }
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && String(obj[k]).trim() !== "") return String(obj[k]);
  }
  return undefined;
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const body = await readBody(req);

    // If multipart from Jotform, answers live in body.rawRequest
    const rr = body.rawRequest || {};

    // Map your current Jotform field IDs (from your log sample)
    const email      = rr.q27_whatsYour27 || rr.email;
    const first_name = (rr.q24_whatsYour24 && rr.q24_whatsYour24.first) || rr.first_name;
    const last_name  = (rr.q24_whatsYour24 && rr.q24_whatsYour24.last)  || rr.last_name;
    const phone      = (rr.q26_whatsYour26 && rr.q26_whatsYour26.full) ||
                       (rr.q25_whatsYour25 && rr.q25_whatsYour25.full) || rr.phone;
    const eventId    = rr.event_id;

    // Source URL: prefer Referer; else Jotform form URL; else safe default
    const formId = body.formID || rr.formID;
    const event_source_url =
      req.headers.referer ||
      (formId ? `https://www.jotform.com/${formId}` : "https://lyftgrowth.com/lead-form");

    // Debug log (view in Vercel → Logs)
    console.log("Jotform parsed:", { email, first_name, last_name, phone, eventId, formId, event_source_url });

    const user_data = {
      em: email ? [sha256(email)] : undefined,
      ph: phone ? [sha256(phone)] : undefined,
      fn: sha256(first_name),
      ln: sha256(last_name),
      client_ip_address: String(req.headers["x-forwarded-for"] || "").split(",")[0] || undefined,
      client_user_agent: req.headers["user-agent"]
    };
    Object.keys(user_data).forEach(k => user_data[k] === undefined && delete user_data[k]);

    const payload = {
      data: [{
        event_name: "Lead",
        event_time: now(),
        event_id: eventId,           // optional dedupe id
        action_source: "website",
        event_source_url,
        user_data,
        custom_data: { source: "jotform_webhook" }
      }],
      ...(process.env.META_TEST_EVENT_CODE ? { test_event_code: process.env.META_TEST_EVENT_CODE } : {})
    };

    const pixelId = process.env.META_PIXEL_ID;
    const accessToken = process.env.META_ACCESS_TOKEN;

    if (!pixelId || !accessToken) {
      return res.status(500).json({ ok: false, error: "Missing META_PIXEL_ID or META_ACCESS_TOKEN env vars" });
    }

    const fb = await fetch(`https://graph.facebook.com/v21.0/${pixelId}/events?access_token=${accessToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const json = await fb.json();
    // Log Meta response for quick diagnostics
    console.log("Meta CAPI response:", json);

    return res.status(fb.ok ? 200 : 500).json({ ok: fb.ok, meta: json });
  } catch (e) {
    console.error("CAPI handler error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "Unknown error" });
  }
};
