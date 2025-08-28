// /api/meta-capi-app.js — Vercel Serverless Function (plain JS)
// Handles Jotform Smart PDF webhook, parses body (JSON/x-www-form-urlencoded/multipart),
// maps fields, hashes PII, resolves *browser-provided* event_id, and sends a Meta CAPI "Lead".

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
  // Common: YYYY-MM-DD or YYYY/MM/DD
  let m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (m) {
    const y = m[1], mo = m[2].padStart(2, "0"), d = m[3].padStart(2, "0");
    return `${y}${mo}${d}`;
  }
  // Common: MM/DD/YYYY
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const mo = m[1].padStart(2, "0"), d = m[2].padStart(2, "0"), y = m[3];
    return `${y}${mo}${d}`;
  }
  // Fallback: try Date()
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
    const da = String(d.getUTCDate()).padStart(2, "0");
    return `${y}${mo}${da}`;
  }
  return undefined;
}

/** Robust body reader (JSON, urlencoded, multipart) */
async function readBody(req) {
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const raw = Buffer.concat(chunks).toString("utf8");
  const ct = String(req.headers["content-type"] || "");

  if (ct.includes("application/json")) return raw ? JSON.parse(raw) : {};
  if (ct.includes("application/x-www-form-urlencoded")) return parseQS(raw);

  // Multipart parser — tolerant to extra headers in parts
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
      let value = part.slice(idx + 4);
      // Trim trailing CRLF and boundary dashes
      value = value.replace(/\r\n--\s*$/, '').replace(/\r\n$/, '');

      const nameMatch = headers.match(/name="([^"]+)"/i);
      if (!nameMatch) continue;
      const name = nameMatch[1];
      fields[name] = value;
    }

    // Extract Jotform's rawRequest (Smart PDF/standard payload)
    let rr = {};
    try { if (fields.rawRequest) rr = JSON.parse(fields.rawRequest); } catch {}

    // Derive formID if possible (from slug submit/<id>)
    const formID = rr?.slug?.split("/")?.pop() || fields.formID || rr.formID;

    return {
      rawRequest: rr,
      formID,
      // expose top-level common params
      fbp: fields.fbp,
      fbc: fields.fbc,
      parentURL: fields.parentURL || fields.referer,
      fields // expose all fields verbatim (e.g., "name", "email", "mobile18", "event_id", utm_*)
    };
  }

  // Fallback guesses
  try { return JSON.parse(raw); } catch { return parseQS(raw); }
}

/** pick value by exact key or "..._<key>" suffix (e.g., q32_event_id) */
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

/** Prefer hidden/browser-provided event_id over Jotform internal rr.event_id */
function resolveEventId(body, rr) {
  const hidden =
    pickCookieLike(rr, 'event_id') ||
    pickCookieLike(body.fields, 'event_id') ||
    body.event_id || body.eventId || undefined;
  const internal = rr?.event_id || undefined; // Jotform internal composite (avoid)
  return hidden || internal || undefined;
}

/** Split a "name" full string to first / last */
function splitName(full) {
  if (!full || typeof full !== 'string') return { first: undefined, last: undefined };
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: undefined };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/** Attempt to reconstruct _fbc from fbclid in a parent URL if missing */
function reconstructFBCIfNeeded(currentFbc, body, rr, req) {
  if (currentFbc) return currentFbc;
  const parentURL = body.parentURL || rr.parentURL || rr.referer || req.headers.referer || "";
  try {
    const outer = new URL(parentURL, "https://dummy.base");
    const innerCandidate = outer.searchParams.get("parentURL");
    const candidate = innerCandidate ? decodeURIComponent(innerCandidate) : parentURL;
    const u = new URL(candidate, "https://dummy.base");
    const fbclid = u.searchParams.get("fbclid");
    if (fbclid) {
      const ts = Math.floor(Date.now() / 1000);
      return `fb.1.${ts}.${fbclid}`;
    }
  } catch { /* ignore parse errors */ }
  return undefined;
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const body = await readBody(req);
    const rr = body.rawRequest || {};           // Jotform-parsed payload (if multipart)
    const fields = body.fields || body || {};   // flat access to posted fields

    // ---- Browser IDs: accept direct + qNN_suffix + top-level
    let fbp =
      rr.fbp ||
      body.fbp ||
      pickCookieLike(fields, 'fbp') ||
      pickCookieLike(rr, 'fbp');

    let fbc =
      rr.fbc ||
      body.fbc ||
      pickCookieLike(fields, 'fbc') ||
      pickCookieLike(rr, 'fbc');

    fbc = reconstructFBCIfNeeded(fbc, body, rr, req);

    // ---- UTM / click ids (keep in custom_data only)
    const UTM_KEYS = ['utm_source','utm_medium','utm_campaign','utm_term','utm_content'];
    const CLICK_IDS = ['fbclid','gclid','msclkid'];
    const utms = {};
    for (const k of UTM_KEYS) {
      utms[k] =
        fields[k] ??
        rr[k] ??
        pickCookieLike(fields, k) ??
        pickCookieLike(rr, k) ??
        undefined;
      if (!utms[k]) delete utms[k];
    }
    const clickIds = {};
    for (const k of CLICK_IDS) {
      clickIds[k] =
        fields[k] ??
        rr[k] ??
        pickCookieLike(fields, k) ??
        pickCookieLike(rr, k) ??
        undefined;
      if (!clickIds[k]) delete clickIds[k];
    }

    // ---- Required Smart PDF field mappings (your new app form)
    // name: (full string) -> split to first/last
    const fullName =
      fields.name ?? rr.name ?? pickCookieLike(fields, 'name') ?? pickCookieLike(rr, 'name');
    const { first: first_name, last: last_name } = splitName(fullName);

    // email
    const email =
      fields.email ?? rr.email ?? pickCookieLike(fields, 'email') ?? pickCookieLike(rr, 'email');

    // phone (mobile18)
    const phone =
      fields.mobile18 ?? rr.mobile18 ?? pickCookieLike(fields, 'mobile18') ?? pickCookieLike(rr, 'mobile18');

    // DOB (dateOf) -> user_data.db
    const dobRaw =
      fields.dateOf ?? rr.dateOf ?? pickCookieLike(fields, 'dateOf') ?? pickCookieLike(rr, 'dateOf');
    const db = normalizeDOB(dobRaw);

    // Partner fields (we will NOT send partner PII to Meta; log presence only)
    const partnerName =
      fields.partnerName ?? rr.partnerName ?? pickCookieLike(fields, 'partnerName') ?? pickCookieLike(rr, 'partnerName');
    const partnerDOB =
      fields.dateOf22 ?? rr.dateOf22 ?? pickCookieLike(fields, 'dateOf22') ?? pickCookieLike(rr, 'dateOf22');
    const partnerEmail =
      fields.partnerEmail ?? rr.partnerEmail ?? pickCookieLike(fields, 'partnerEmail') ?? pickCookieLike(rr, 'partnerEmail');
    const partnerMobile =
      fields.partnerMobile ?? rr.partnerMobile ?? pickCookieLike(fields, 'partnerMobile') ?? pickCookieLike(rr, 'partnerMobile');

    // Resolve dedupe event_id (hidden/browser-provided preferred)
    const eventId = resolveEventId(body, rr);

    // Neutral source URL (do not expose Jotform URL)
    const event_source_url =
      rr.event_source_url ||
      fields.event_source_url ||
      "https://lyftgrowth.com/go/app/"; // set to your application page URL

    const formId = body.formID || rr.formID;

    // Build user_data (hash PII as required)
    const user_data = {
      em: email ? [sha256(email)] : undefined,
      ph: phone ? [sha256(phone)] : undefined,
      fn: first_name ? sha256(first_name) : undefined,
      ln: last_name ? sha256(last_name) : undefined,
      db: db ? sha256(db) : undefined, // Meta expects *hashed* YYYYMMDD as "db"
      fbp: fbp || undefined,
      fbc: fbc || undefined,
      client_ip_address: String(req.headers["x-forwarded-for"] || "").split(",")[0] || undefined,
      client_user_agent: req.headers["user-agent"]
    };
    Object.keys(user_data).forEach(k => user_data[k] === undefined && delete user_data[k]);

    // Minimal, compliant custom_data — DO NOT include partner PII here
    const custom_data = {
      source: "jotform_webhook_app",
      ...utms,
      ...clickIds,
      // partner presence only (no PII)
      partner_present: Boolean(
        (partnerName && String(partnerName).trim()) ||
        (partnerEmail && String(partnerEmail).trim()) ||
        (partnerMobile && String(partnerMobile).trim()) ||
        (partnerDOB && String(partnerDOB).trim())
      )
    };

    const payload = {
      data: [{
        event_name: "Lead",
        event_time: now(),
        event_id: eventId, // dedupe id from browser
        action_source: "website",
        event_source_url,
        user_data,
        custom_data
      }]
    };

    const pixelId = process.env.META_PIXEL_ID;
    const accessToken = process.env.META_ACCESS_TOKEN;

    if (!pixelId || !accessToken) {
      return res.status(500).json({ ok: false, error: "Missing META_PIXEL_ID or META_ACCESS_TOKEN env vars" });
    }

    // Helpful debug (safe — already hashed PII in user_data)
    console.log("[CAPI:APP] Parsed Smart PDF submission:", {
      formId,
      eventId,
      event_source_url,
      have_fbp: Boolean(fbp),
      have_fbc: Boolean(fbc),
      utms,
      clickIds,
      fieldKeys: Object.keys(fields || {})
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
