// /api/cf/log.js
export default async function handler(req, res) {
  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  console.log('CF HEADERS:', req.headers);
  console.log('CF BODY:', body);
  res.status(200).json({ ok: true });
}
