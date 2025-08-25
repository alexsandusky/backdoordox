// /api/meta-capi.js  (root-level Vercel Serverless Function, plain JS)
const crypto = require("crypto");
const { parse: parseQS } = require("querystring");

function sha256(v) {
  if (!v) return undefined;
  const s = String(v).trim().toLowerCase();
  return crypto.createHash("sha256").update(s).digest("hex");
}
const now = () => Math.floor(Date.now() / 1000);

async function readBody(req) {
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const raw = Buffer.concat(chunks).toString("utf8");
  const ct = String(req.headers["content-type"] || "");
  if (ct.includes("application/json")) return raw ? JSON.parse(raw) : {};
  if (ct.includes("application/x-www-form-urlencoded")) return parseQS(raw);
  try { return JSON.parse(raw); } catch { return parseQS(raw); }
}

function pick(obj, keys) {
  for (const k of keys) if (obj && obj[k] != null && String(obj[k]).trim() !== "") return String(obj[k]);
  return undefined;
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const body = await readBody(req);
    console.log("Incoming webhook body:", body);

    // Map common Jotform field names → normalized
    const email = pick(body, ["email","q3_email","q3_email[email]","client_email","Email"]);
    const phone = pick(body, ["phone","q4_phone","q4_phone[full]","phoneNumber","phoneNumber[full]","mobile"]);
    const first_name = pick(body, ["first_name","firstname","first","q1_name[first]","name[first]"]);
    const last_name  = pick(body, ["last_name","lastname","last","q1_name[last]","name[last]"]);

    const formId = pick(body, ["formID","formId"]);
    const event_source_url =
      req.headers.referer ||
      (formId ? `https://www.jotform.com/${formId}` : "https://lyftgrowth.com/lead-form");

    const payload = {
      data: [{
        event_name: "Lead",
        event_time: now(),
        action_source: "website",
        event_source_url,
        user_data: {
          em: email ? [sha256(email)] : undefined,
          ph: phone ? [sha256(phone)] : undefined,
          fn: sha256(first_name),
          ln: sha256(last_name),
          client_ip_address: String(req.headers["x-forwarded-for"] || "").split(",")[0] || undefined,
          client_user_agent: req.headers["user-agent"]
        },
        custom_data: { source: "jotform_webhook" }
      }],
      ...(process.env.META_TEST_EVENT_CODE ? { test_event_code: process.env.META_TEST_EVENT_CODE } : {})
    };

    const pixelId = process.env.META_PIXEL_ID;
    const accessToken = process.env.META_ACCESS_TOKEN;

    const fb = await fetch(`https://graph.facebook.com/v21.0/${pixelId}/events?access_token=${accessToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const json = await fb.json();
    return res.status(fb.ok ? 200 : 500).json({ ok: fb.ok, meta: json });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "Unknown error" });
  }
};
