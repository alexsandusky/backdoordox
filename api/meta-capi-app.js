// /api/meta-capi-app.js — Vercel Serverless Function
// Jotform Smart PDF webhook -> Meta CAPI "Submit Application"

const crypto = require("crypto");
const { parse: parseQS } = require("querystring");

function sha256(v) {
  if (!v) return undefined;
  const s = String(v).trim().toLowerCase();
  return crypto.createHash("sha256").update(s).digest("hex");
}
const now = () => Math.floor(Date.now() / 1000);

// Normalize DOB -> YYYYMMDD
function normalizeDOB(v) {
  if (!v) return undefined;
  let s = String(v).trim();
  let m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (m) return `${m[1]}${m[2].padStart(2,"0")}${m[3].padStart(2,"0")}`;
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
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

// Read body (JSON, urlencoded, multipart)
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
    return { rawRequest: rr, formID, fbp: fields.fbp, fbc: fields.fbc, fields };
  }

  try { return JSON.parse(raw); } catch { return parseQS(raw); }
}

// Accept exact key or "..._<key>" suffix
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

// Extract from rr.answers by unique name (Smart PDF)
function jfAnswer(rr, unique) {
  const answers = rr && rr.answers ? rr.answers : undefined;
  if (!answers || typeof answers !== 'object') return undefined;

  for (const k of Object.keys(answers)) {
    const a = answers[k];
    // Jotform variants: a.name, a.key, a.text; value may be in a.answer or a.value
    const nm = a?.name || a?.key;
    if (nm !== unique) continue;

    const val = a?.answer ?? a?.value ?? a?.valueText ?? a?.pretty ?? a?.text ?? a;
    if (val == null) return undefined;

    // normalize shapes
    if (typeof val === 'string') return val.trim();

    if (typeof val === 'object') {
      // name objects: {first,last} or {firstName,lastName}
      if (val.first || val.last) {
        const first = String(val.first || val.firstName || '').trim();
        const last  = String(val.last || val.lastName || '').trim();
        return { first, last };
      }
      // phone objects: {full, phone, area, number}
      if (val.full || val.phone) {
        return String(val.full || val.phone || '').trim();
      }
      // date objects: {year, month, day}
      if (val.year && val.month && val.day) {
        const y = String(val.year).padStart(4,'0');
        const m = String(val.month).padStart(2,'0');
        const d = String(val.day).padStart(2,'0');
        return `${y}-${m}-${d}`;
      }
    }
  }
  return undefined;
}

// Prefer hidden/browser event_id over Jotform internal rr.event_id
function resolveEventId(body, rr) {
  const hidden =
    pickCookieLike(rr, 'event_id') ||
    pickCookieLike(body.fields, 'event_id') ||
    body.event_id || body.eventId || undefined;
  const internal = rr?.event_id || undefined;
  return hidden || internal || undefined;
}

function splitNameFromAny(v) {
  if (!v) return { first: undefined, last: undefined };
  if (typeof v === 'object') {
    return { first: v.first || undefined, last: v.last || undefined };
  }
  if (typeof v === 'string') {
    const parts = v.trim().split(/\s+/);
    if (parts.length === 1) return { first: parts[0], last: undefined };
    return { first: parts[0], last: parts.slice(1).join(' ') };
  }
  return { first: undefined, last: undefined };
}

// Rebuild _fbc from fbclid in referer if missing
function reconstructFBCIfNeeded(currentFbc, body, rr, req) {
  if (currentFbc) return currentFbc;
  const parentURL = body.parentURL || rr.parentURL || req.headers.referer || "";
  try {
    const u = new URL(parentURL, "https://dummy.base");
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

    // --- UTMs / click IDs (for custom_data)
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



    
// ---- Robust Smart PDF extraction across rr.answers *and* rr root qNN_* ----
function extractApplicant(rr) {
  const out = { name: undefined, email: undefined, phone: undefined, dob: undefined };

  const isEmail = v => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
  const asString = v => typeof v === 'string' ? v.trim() : undefined;
  const normPhone = v => {
    if (!v) return undefined;
    const s = typeof v === 'string' ? v : (v.full || v.phone || v.number || '');
    if (!s) return undefined;
    const keep = s.replace(/[^\d+]/g, '');
    return keep.length >= 7 ? keep : undefined;
  };

  // helpers that try to pull values from a generic "answer-like" object
  function readGeneric(val, keyHint = '') {
    // name objects
    if (val && typeof val === 'object' && (val.first || val.last || val.firstName || val.lastName)) {
      return { type: 'name', value: { first: val.first || val.firstName || '', last: val.last || val.lastName || '' } };
    }
    // date objects
    if (val && typeof val === 'object' && (val.year && val.month && val.day)) {
      const y = String(val.year).padStart(4,'0');
      const m = String(val.month).padStart(2,'0');
      const d = String(val.day).padStart(2,'0');
      return { type: 'dob', value: `${y}-${m}-${d}` };
    }
    // phone objects
    const pObj = val && typeof val === 'object' && (val.full || val.phone || val.number) ? normPhone(val) : undefined;
    if (pObj) return { type: 'phone', value: pObj };

    // strings
    const s = asString(val);
    if (s) {
      if (isEmail(s) || /(^|[^a-z])email([^a-z]|$)/i.test(keyHint)) return { type: 'email', value: s };
      if (/(phone|mobile|cell|tel)/i.test(keyHint)) {
        const p = normPhone(s); if (p) return { type: 'phone', value: p };
      }
      if (/(\d{4}[-/]\d{1,2}[-/]\d{1,2})|(\d{1,2}[-/]\d{1,2}[-/]\d{4})/.test(s) ||
          /(dob|birth|dateof|date_of|date-of)/i.test(keyHint)) return { type: 'dob', value: s };
      if (/(name|applicant)/i.test(keyHint)) return { type: 'name', value: s };
    }
    return null;
  }

  function maybeSet(kind, value) {
    if (kind === 'email' && !out.email) out.email = value;
    if (kind === 'phone' && !out.phone) out.phone = value;
    if (kind === 'dob' && !out.dob) out.dob = value;
    if (kind === 'name' && !out.name) out.name = value;
  }

  // 1) Scan rr.answers if present
  if (rr && rr.answers && typeof rr.answers === 'object') {
    for (const k of Object.keys(rr.answers)) {
      const a = rr.answers[k];
      const nm = (a?.name || a?.key || '').toString().toLowerCase();
      const val = a?.answer ?? a?.value ?? a?.valueText ?? a?.pretty ?? a?.text ?? a;
      const got = readGeneric(val, nm);
      if (got) maybeSet(got.type, got.value);
    }
  }

  // 2) Scan top-level rr (qNN_* keys etc.)
  if (rr && typeof rr === 'object') {
    for (const k of Object.keys(rr)) {
      // Skip known meta keys (utm, fb cookies, tracker, etc.)
      if (/^(slug|upload|jsExecutionTracker|submit|build|validated|path|timeToSubmit)$/i.test(k)) continue;
      if (/^(q\d+_utm|utm_|q\d+_fbc|q\d+_fbp|fbp|fbc|event_id)$/i.test(k)) continue;

      const v = rr[k];
      const got = readGeneric(v, k.toLowerCase());
      if (got) maybeSet(got.type, got.value);
    }
  }

  return out;
}

// Use the extractor
const scanned = extractApplicant(rr);

// Convert to final fields
const { first: first_name, last: last_name } = (() => {
  if (!scanned.name) return { first: undefined, last: undefined };
  if (typeof scanned.name === 'object') return { first: scanned.name.first || undefined, last: scanned.name.last || undefined };
  const parts = String(scanned.name).trim().split(/\s+/);
  return parts.length > 1 ? { first: parts[0], last: parts.slice(1).join(' ') } : { first: parts[0], last: undefined };
})();

const email = scanned.email;
let phone  = scanned.phone;
if (phone) phone = phone.replace(/[^\d+]/g, '');
const db = normalizeDOB(scanned.dob);

// Debug (non-PII)
console.log('[CAPI:APP] Detect:', {
  got_first: Boolean(first_name),
  got_last: Boolean(last_name),
  got_email: Boolean(email),
  got_phone: Boolean(phone),
  got_db: Boolean(db),
  rr_keys: rr ? Object.keys(rr).length : 0,
  has_answers: Boolean(rr && rr.answers),
  answer_keys: rr && rr.answers ? Object.keys(rr.answers) : []
});




    


    // Dedupe id
    const eventId = resolveEventId(body, rr);

    // user_data (hashed)
    const user_data = {
      em: email ? [sha256(email)] : undefined,
      ph: phone ? [sha256(phone)] : undefined,
      fn: first_name ? sha256(first_name) : undefined,
      ln: last_name ? sha256(last_name) : undefined,
      db: db ? sha256(db) : undefined,
      fbp: fbp || undefined,
      fbc: fbc || undefined,
      client_ip_address: String(req.headers["x-forwarded-for"] || "").split(",")[0] || undefined,
      client_user_agent: req.headers["user-agent"]
    };
    Object.keys(user_data).forEach(k => user_data[k] === undefined && delete user_data[k]);

    // custom_data
    const custom_data = { source: "jotform_webhook_app" };

    // Build payload
    const payload = {
      data: [{
        event_name: "SubmitApplication", 
        event_time: now(),
        event_id: eventId,
        action_source: "website",
        event_source_url: "https://go.lyftcapital.com/application",
        user_data,
        custom_data
      }]
    };

    const pixelId = process.env.META_PIXEL_ID;
    const accessToken = process.env.META_ACCESS_TOKEN;
    const testEventCode = process.env.META_TEST_EVENT_CODE; // optional

    if (!pixelId || !accessToken) {
      return res.status(500).json({ ok: false, error: "Missing META_PIXEL_ID or META_ACCESS_TOKEN" });
    }

    // Debug: show what we extracted (non-PII)
    console.log("[CAPI:APP] Parsed submission:", {
      eventId,
      have_fbp: Boolean(fbp),
      have_fbc: Boolean(fbc),
      got_first: Boolean(first_name),
      got_last: Boolean(last_name),
      got_email: Boolean(email),
      got_phone: Boolean(phone),
      got_db: Boolean(db),
      utms,
      clickIds,
      // helpful to confirm Smart PDF answers presence
      has_answers: Boolean(rr && rr.answers),
      answer_keys: rr && rr.answers ? Object.keys(rr.answers) : []
    });

    // Build request URL
    const url = new URL(`https://graph.facebook.com/v21.0/${pixelId}/events`);
    url.searchParams.set("access_token", accessToken);
    if (testEventCode) url.searchParams.set("test_event_code", testEventCode);

    console.log('[CAPI:APP] Graph URL:', url.toString());

    
    // Send to Meta
    const graphResp = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const json = await graphResp.json();
    console.log("[CAPI:APP] Meta response:", json);

    return res.status(graphResp.ok ? 200 : 500).json({ ok: graphResp.ok, meta: json });
  } catch (e) {
    console.error("[CAPI:APP] Handler error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "Unknown error" });
  }
};
