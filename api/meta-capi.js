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

  // Robust multipart parser (handles boundaries + extra headers in parts)
  if (ct.includes("multipart/form-data")) {
    const m = ct.match(/boundary=([^;]+)/i);
    if (!m) return { _multipart: raw }; // no boundary? return raw for debugging
    const boundary = m[1];
    const parts = raw.split(`--${boundary}`);

    const fields = {};
    for (const part of parts) {
      if (!part || part === '--\r\n' || part === '--') continue;
      const idx = part.indexOf('\r\n\r\n');
      if (idx === -1) continue;
      const headers = part.slice(0, idx);
      let value = part.slice(idx + 4);
      // Trim trailing CRLF and boundary dashes
      value = value.replace(/\r\n--\s*$/, '').replace(/\r\n$/, '');

      const nameMatch = headers.match(/name="([^"]+)"/i);
      if (!nameMatch) continue;
      const name = nameMatch[1];
      fields[name] = value;
    }

    // Extract rawRequest JSON if present
    let rr = {};
    try { if (fields.rawRequest) rr = JSON.parse(fields.rawRequest); } catch {}

    // Try to derive formID from slug `submit/<id>`
    const formID = rr?.slug?.split("/")?.pop() || fields.formID;

    return {
      rawRequest: rr,
      formID,
      fbp: fields.fbp,
      fbc: fields.fbc,
      parentURL: fields.parentURL,
      fields // expose all (e.g., q31_fbc, q30_fbp)
    };
  }

  // Fallback attempts
  try { return JSON.parse(raw); } catch { return parseQS(raw); }
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const body = await readBody(req);

    // If multipart from Jotform, answers live in body.rawRequest
    const rr = body.rawRequest || {};

    // Helper: pick value by exact key or Jotform's qNN_suffix pattern
    function pickCookieLike(obj, key) {
      if (!obj) return undefined;
      for (const k of Object.keys(obj)) {
        if (k === key || k.endsWith('_' + key)) {
          const v = obj[k];
          if (typeof v === 'string' && v.trim()) return v.trim();
        }
      }
      return undefined;
    }

    // Browser IDs from hidden fields or rawRequest; accept qNN_fbp/qNN_fbc too
    let fbp = rr.fbp || body.fbp || pickCookieLike(body.fields, 'fbp') || pickCookieLike(rr, 'fbp');
    let fbc = rr.fbc || body.fbc || pickCookieLike(body.fields, 'fbc') || pickCookieLike(rr, 'fbc');

    // If fbc missing, reconstruct from fbclid in parentURL/referer (common in Jotform payloads)
    if (!fbc) {
      const parentURL = body.parentURL || rr.parentURL || rr.referer || req.headers.referer || "";
      try {
        // parentURL may be encoded inside another URL (?parentURL=<encoded>)
        const outer = new URL(parentURL, "https://dummy.base");
        const innerCandidate = outer.searchParams.get("parentURL");
        const candidate = innerCandidate ? decodeURIComponent(innerCandidate) : parentURL;
        const u = new URL(candidate, "https://dummy.base");
        const fbclid = u.searchParams.get("fbclid");
        if (fbclid) {
          const ts = Math.floor(Date.now() / 1000);
          fbc = `fb.1.${ts}.${fbclid}`;
        }
      } catch { /* ignore parse errors */ }
    }

    // Map your current Jotform field IDs (from your log sample)
    const email      = rr.q27_whatsYour27 || rr.email;
    const first_name = (rr.q24_whatsYour24 && rr.q24_whatsYour24.first) || rr.first_name;
    const last_name  = (rr.q24_whatsYour24 && rr.q24_whatsYour24.last)  || rr.last_name;

    // Two phones: business + personal
    const business_phone = rr.q25_whatsYour25 && rr.q25_whatsYour25.full;
    const personal_phone = rr.q26_whatsYour26 && rr.q26_whatsYour26.full;
    const phones = [business_phone, personal_phone].filter(Boolean);

    const eventId = rr.event_id;

    // Always use a neutral, compliant URL instead of exposing Jotform
    const event_source_url = "https://lyftgrowth.com/go/tsgf/survey/";
    const formId = body.formID || rr.formID;

    // Debug log (view in Vercel → Logs)
    console.log("Jotform parsed:", {
      email, first_name, last_name, phones, eventId, formId, event_source_url,
      fbp, fbc,
      fieldKeys: body.fields ? Object.keys(body.fields) : []
    });

    const user_data = {
      em: email ? [sha256(email)] : undefined,
      ph: phones.length ? phones.map(p => sha256(p)) : undefined,
      fn: sha256(first_name),
      ln: sha256(last_name),
      fbp,
      fbc,
      client_ip_address: String(req.headers["x-forwarded-for"] || "").split(",")[0] || undefined,
      client_user_agent: req.headers["user-agent"]
    };
    Object.keys(user_data).forEach(k => user_data[k] === undefined && delete user_data[k]);

    const payload = {
      data: [{
        event_name: "Lead",
        event_time: now(),
        event_id: eventId, // optional dedupe id
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

    console.log("Using pixel/test:", {
      pixelId: process.env.META_PIXEL_ID,
      testEventCode: process.env.META_TEST_EVENT_CODE
    });
    console.log("Payload to Meta:", JSON.stringify(payload, null, 2));

    const fb = await fetch(`https://graph.facebook.com/v21.0/${pixelId}/events?access_token=${accessToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const json = await fb.json();
    console.log("Meta CAPI response:", json);

    return res.status(fb.ok ? 200 : 500).json({ ok: fb.ok, meta: json });
  } catch (e) {
    console.error("CAPI handler error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "Unknown error" });
  }
};
