// /api/meta-capi-app.js — Vercel Serverless Function (plain JS)
// Jotform Smart PDF webhook -> Meta CAPI "Submit Application" event
// Uses browser-provided event_id (from hidden field), *not* Jotform's internal one.

const crypto = require("crypto");
const { parse: parseQS } = require("querystring");

function sha256(v) {
  if (!v) return undefined;
  const s = String(v).trim().toLowerCase();
  return crypto.createHash("sha256").update(s).digest("hex");
}
const now = () => Math.floor(Date.now() / 1000);

/** Normalize DOB -> YYYYMMDD for Meta user_data.db */
function normalizeDOB(v) {
  if (!v) return undefined;
  let s = String(v).trim();
  let m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/); // YYYY-MM-DD
  if (m) return `${m[1]}${m[2].padStart(2,"0")}${m[3].padStart(2,"0")}`;
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);     // MM/DD/YYYY
  if (m) return `${m[3]}${m[1].padStart(2,"0")}${m[2].padStart(2,"0")}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth()+1).padStart(2,"0");
    const da = String(d.getUTCDate()).padStart(2,"0");
    return `${y}${mo}${da}`;
  }
  return undefined;
}

/** Read body (JSON, urlencoded, multipart) */
async function readBody(req) {
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const raw = Buffer.concat(chunks).toString("utf8");
  const ct = String(req.headers["content-type"] || "");

  if (ct.includes("application/json")) return raw ? JSON.parse(raw) : {};
  if (ct.includes("application/x-www-form-urlencoded")) return parseQS(raw);

  if (ct.includes("multipart/form-data")) {
    const m = ct.match(/boundary=([^;]+)/i);
    if (!m) return { _multipart: raw };
    const boundary = m[1];
    const parts = raw.split(`--${boundary}`);
    const fields = {};
    for (const part of parts) {
      if (!part || part === '--\r\n' || part === '--') continue;
      const idx = part.indexOf('\r\n\r\n');
      if (idx === -1) continue;
      const headers = part.slice(0, idx);
      let value = part.slice(idx + 4).replace(/\r\n--\s*$/, '').replace(/\r\n$/, '');
      const nameMatch = headers.match(/name="([^"]+)"/i);
      if (!nameMatch) continue;
      fields[nameMatch[1]] = value;
    }
    let rr = {};
    try { if (fields.rawRequest) rr = JSON.parse(fields.rawRequest); } catch {}
    const formID = rr?.slug?.split("/")?.pop() || fields.formID || rr.formID;
    return { rawRequest: rr, formID, fbp: fields.fbp, fbc: fields.fbc, parentURL: fields.parentURL || fields.referer, fields };
  }

  try { return JSON.parse(raw); } catch { return parseQS(raw); }
}

/** Accept exact key or "..._<key>" suffix (e.g., q32_event_id) */
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

/** Prefer hidden/browser event_id over Jotform internal rr.event_id */
function resolveEventId(body, rr) {
  const hidden =
    pickCookieLike(rr, 'event_id') ||
    pickCookieLike(body.fields, 'event_id') ||
    body.event_id || body.eventId || undefined;
  const internal = rr?.event_id || undefined; // avoid using this
  return hidden || internal || undefined;
}

/** Split a full name into first/last */
function splitName(full) {
  if (!full || typeof full !== 'string') return { first: undefined, last: undefined };
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: undefined };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/** Rebuild _fbc from fbclid in parentURL if missing */
function reconstructFBCIfNeeded(currentFbc, body, rr, req) {
  if (currentFbc) return currentFbc;
  const parentURL = body.parentURL || rr.parentURL || rr.referer || req.headers.referer || "";
  try {
    const outer = new URL(parentURL, "https://dummy.base");
    const innerCandidate = outer.searchParams.get("parentURL");
    const candidate = innerCandidate ? decodeURIComponent(innerCandidate) : parentURL;
    const u = new URL(candidate, "https://dummy.base");
    const fbclid = u.searchParams.get("fbclid");
    if (fbclid) return `fb.1.${Math.floor(Date.now()/1000)}.${fbclid}`;
  } catch {}
  return undefined;
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const body = await readBody(req);
    const rr = body.rawRequest || {};
    const fields = body.fields || body || {};

    // --- Browser IDs
    let fbp = rr.fbp || body.fbp || pickCookieLike(fields, 'fbp') || pickCookieLike(rr, 'fbp');
    let fbc = rr.fbc || body.fbc || pickCookieLike(fields, 'fbc') || pickCookieLike(rr, 'fbc');
    fbc = reconstructFBCIfNeeded(fbc, body, rr, req);

    // --- UTMs / click IDs (custom_data only)
    const UTM_KEYS = ['utm_source','utm_medium','utm_campaign','utm_term','utm_content'];
    const CLICK_IDS = ['fbclid','gclid','msclkid'];
    const utms = {};
    for (const k of UTM_KEYS) {
      const v = fields[k] ?? rr[k] ?? pickCookieLike(fields, k) ?? pickCookieLike(rr, k);
      if (v) utms[k] = v;
    }
    const clickIds = {};
    for (const k of CLICK_IDS) {
      const v = fields[k] ?? rr[k] ?? pickCookieLike(fields, k) ?? pickCookieLike(rr, k);
      if (v) clickIds[k] = v;
    }

    // --- Applicant fields (NO partner PII sent)
    const fullName = fields.name ?? rr.name ?? pickCookieLike(fields, 'name') ?? pickCookieLike(rr, 'name');
    const { first: first_name, last: last_name } = splitName(fullName);

    const email = fields.email ?? rr.email ?? pickCookieLike(fields, 'email') ?? pickCookieLike(rr, 'email');
    const phone = fields.mobile18 ?? rr.mobile18 ?? pickCookieLike(fields, 'mobile18') ?? pickCookieLike(rr, 'mobile18');

    const dobRaw = fields.dateOf ?? rr.dateOf ?? pickCookieLike(fields, 'dateOf') ?? pickCookieLike(rr, 'dateOf');
    const db = normalizeDOB(dobRaw);

    // Dedupe id
    const eventId = resolveEventId(body, rr);

    // Neutral source URL
    const event_source_url = "https://lyftgrowth.com/go/tsgf/application/";
    const formId = body.formID || rr.formID;

    // user_data (hash PII)
    const user_data = {
      em: email ? [sha256(email)] : undefined,
      ph: phone ? [sha256(phone)] : undefined,
      fn: first_name ? sha256(first_name) : undefined,
      ln: last_name ? sha256(last_name) : undefined,
      db: db ? sha256(db) : undefined, // hashed YYYYMMDD
      fbp: fbp || undefined,
      fbc: fbc || undefined,
      client_ip_address: String(req.headers["x-forwarded-for"] || "").split(",")[0] || undefined,
      client_user_agent: req.headers["user-agent"]
    };
    Object.keys(user_data).forEach(k => user_data[k] === undefined && delete user_data[k]);

    // custom_data — UTMs & click IDs only
    const custom_data = { source: "jotform_webhook_app", ...utms, ...clickIds };

    const payload = {
      data: [{
        event_name: "Submit Application",   // <-- updated per request
        event_time: now(),
        event_id: eventId,
        action_source: "website",
        event_source_url,
        user_data,
        custom_data
      }]
    };


// inside handler, after building `payload`
const testEventCode =
  fields.meta_test_event_code || rr.meta_test_event_code || undefined;

const url = new URL(`https://graph.facebook.com/v21.0/${pixelId}/events`);
url.searchParams.set('access_token', accessToken);
if (testEventCode) url.searchParams.set('test_event_code', testEventCode);

const fb = await fetch(url.toString(), {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload)
});


    

    
    const pixelId = process.env.META_PIXEL_ID;
    const accessToken = process.env.META_ACCESS_TOKEN;
    if (!pixelId || !accessToken) {
      return res.status(500).json({ ok: false, error: "Missing META_PIXEL_ID or META_ACCESS_TOKEN env vars" });
    }

    console.log("[CAPI:APP] Parsed submission:", {
      formId, eventId, event_source_url, have_fbp: Boolean(fbp), have_fbc: Boolean(fbc),
      utms, clickIds, fieldKeys: Object.keys(fields || {})
    });

    const fb = await fetch(`https://graph.facebook.com/v21.0/${pixelId}/events?access_token=${accessToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const json = await fb.json();
    console.log("[CAPI:APP] Meta response:", json);

    return res.status(fb.ok ? 200 : 500).json({ ok: fb.ok, meta: json });
  } catch (e) {
    console.error("[CAPI:APP] Handler error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "Unknown error" });
  }
};
