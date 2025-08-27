// /api/meta-capi.js — Vercel Serverless Function (plain JS)
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

// --- Debug helper
const DEBUG = true;
function dumpWebhook(body, ct, raw) {
  if (!DEBUG) return;
  try {
    console.log("[WB][content-type]", ct);
    console.log("[WB][raw first 2000]", (raw || "").slice(0, 2000));
    console.log("[WB][body keys]", Object.keys(body || {}));

    if (body.fields) {
      console.log("[WB][fields keys]", Object.keys(body.fields));
      console.log("[WB][fields.event_id]", body.fields.event_id);
    }

    const rr = body.rawRequest || {};
    console.log("[WB][rawRequest keys]", Object.keys(rr || {}));
    if (rr.answers) {
      const names = [];
      for (const a of Object.values(rr.answers)) {
        if (a && a.name) names.push(a.name);
      }
      console.log("[WB][answers names]", names);
      const ev = Object.values(rr.answers).find(a => a && a.name === "event_id");
      console.log("[WB][answers.event_id]", ev ? (ev.answer ?? ev.value) : undefined);
    }
  } catch (e) {
    console.log("[WB][dump error]", e.message);
  }
}

// --- Read body (handles json, urlencoded, multipart)
async function readBody(req) {
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const raw = Buffer.concat(chunks).toString("utf8");

  const ctRaw = String(req.headers["content-type"] || ""); // keep original
  const ct = ctRaw.toLowerCase();                          // for type checks

  if (ct.includes("application/json")) {
    const obj = raw ? JSON.parse(raw) : {};
    obj._raw = raw; obj._ct = ct;
    return obj;
  }
  if (ct.includes("application/x-www-form-urlencoded")) {
    const obj = parseQS(raw);
    obj._raw = raw; obj._ct = ct;
    return obj;
  }

  if (ct.includes("multipart/form-data")) {
    // IMPORTANT: extract boundary from ORIGINAL header (case-sensitive)
    const m = ctRaw.match(/boundary=([^;]+)/i);
    if (!m) return { _multipart: raw, _raw: raw, _ct: ct };

    const boundary = m[1];
    const parts = raw.split(`--${boundary}`);

    const fields = {};
    for (const part of parts) {
      if (!part || part === '--\r\n' || part === '--' || part === '\r\n') continue;

      const sep = part.indexOf('\r\n\r\n');
      if (sep === -1) continue;
      const headerBlock = part.slice(0, sep);
      let bodyBlock = part.slice(sep + 4);

      // Trim trailing CRLF and boundary endings
      bodyBlock = bodyBlock.replace(/\r\n--\s*$/, '').replace(/\r\n$/, '');

      const nameMatch = headerBlock.match(/name="([^"]+)"/i);
      if (!nameMatch) continue;
      const name = nameMatch[1];

      fields[name] = bodyBlock;
    }

    // Parse the Jotform JSON if present
    let rr = {};
    try {
      if (fields.rawRequest) rr = JSON.parse(fields.rawRequest);
    } catch (e) {
      fields._rawRequest_parse_error = String(e && e.message || 'parse error');
    }

    const formID = (rr && rr.slug && rr.slug.split('/').pop()) || fields.formID;

    return {
      rawRequest: rr,
      formID,
      fbp: fields.fbp,
      fbc: fields.fbc,
      parentURL: fields.parentURL,
      fields,
      _raw: raw,
      _ct: ct
    };
  }

  // Fallback
  try {
    const obj = JSON.parse(raw);
    obj._raw = raw; obj._ct = ct;
    return obj;
  } catch {
    const obj = parseQS(raw);
    obj._raw = raw; obj._ct = ct;
    return obj;
  }
}

// --- Main handler
module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const body = await readBody(req);
    dumpWebhook(body, body._ct, body._raw);

    const rr = body.rawRequest || {};

    // Helpers
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

    function getAnswerByName(rr, target) {
      if (!rr || !rr.answers) return undefined;
      const want = String(target).toLowerCase();
      for (const a of Object.values(rr.answers)) {
        const name = a && a.name ? String(a.name).toLowerCase() : '';
        if (name === want) return (a.answer != null ? a.answer : a.value);
      }
      return undefined;
    }

    function resolveEventId(body, rr) {
      return (
        getAnswerByName(rr, 'event_id') ||
        pickCookieLike(body.fields, 'event_id') ||
        body.event_id || body.eventId ||
        undefined
      );
    }

    // Collect IDs
    let fbp = rr.fbp || body.fbp || pickCookieLike(body.fields, 'fbp') || pickCookieLike(rr, 'fbp');
    let fbc = rr.fbc || body.fbc || pickCookieLike(body.fields, 'fbc') || pickCookieLike(rr, 'fbc');

    if (!fbc) {
      const parentURL = body.parentURL || rr.parentURL || rr.referer || req.headers.referer || "";
      try {
        const outer = new URL(parentURL, "https://dummy.base");
        const innerCandidate = outer.searchParams.get("parentURL");
        const candidate = innerCandidate ? decodeURIComponent(innerCandidate) : parentURL;
        const u = new URL(candidate, "https://dummy.base");
        const fbclid = u.searchParams.get("fbclid");
        if (fbclid) {
          const ts = Math.floor(Date.now() / 1000);
          fbc = `fb.1.${ts}.${fbclid}`;
        }
      } catch {}
    }

    // Map your current Jotform field IDs (from your log sample)
    const email      = rr.q27_whatsYour27 || rr.email;
    const first_name = (rr.q24_whatsYour24 && rr.q24_whatsYour24.first) || rr.first_name;
    const last_name  = (rr.q24_whatsYour24 && rr.q24_whatsYour24.last)  || rr.last_name;
    const business_phone = rr.q25_whatsYour25 && rr.q25_whatsYour25.full;
    const personal_phone = rr.q26_whatsYour26 && rr.q26_whatsYour26.full;
    const phones = [business_phone, personal_phone].filter(Boolean);

    const eventId = resolveEventId(body, rr);
    const event_source_url = "https://lyftgrowth.com/go/tsgf/survey/";
    const formId = body.formID || rr.formID;

    console.log("EventId sources:", {
      from_answers: getAnswerByName(rr, 'event_id'),
      fields_event_id: pickCookieLike(body.fields, 'event_id'),
      body_event_id: body.event_id,
      body_eventId: body.eventId,
      resolved: eventId
    });

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
        event_id: eventId,
        action_source: "website",
        event_source_url,
        user_data,
        custom_data: { source: "jotform_webhook" }
      }]
    };

    const pixelId = process.env.META_PIXEL_ID;
    const accessToken = process.env.META_ACCESS_TOKEN;
    if (!pixelId || !accessToken) {
      return res.status(500).json({ ok: false, error: "Missing META_PIXEL_ID or META_ACCESS_TOKEN env vars" });
    }

    console.log("Using pixel:", { pixelId });
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
