// /api/cf/log.js
module.exports = async (req, res) => {
  // 1) Always 200 for non-POST (CF "Save Webhook" probes can be GET/HEAD/OPTIONS)
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send('ok');
  }

  // 2) For POST: stream raw body (works for JSON or form-encoded)
  let raw = '';
  try {
    for await (const chunk of req) raw += chunk;
  } catch (e) {
    // ignore
  }

  // Try JSON parse; if fails, keep raw text
  let payload = raw;
  try { payload = JSON.parse(raw); } catch (_) {}

  console.log('CF WEBHOOK HEADERS:', req.headers);
  console.log('CF WEBHOOK BODY:', payload);

  // 3) Respond fast
  res.status(200).json({ ok: true });
};
