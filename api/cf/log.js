// /api/cf/log.js
export default async function handler(req, res) {
  // Allow everything CF might send during “Save Webhook”
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send('ok');
  }

  // Real event POSTs
  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  console.log('CF HEADERS:', req.headers);
  console.log('CF BODY:', body);
  return res.status(200).json({ ok: true });
}
