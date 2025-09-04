// /api/cf/log.js
module.exports = async (req, res) => {
  // accept anything CF sends during "Save"
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send('ok');
  }
  // real webhook POSTs
  let raw = '';
  try { raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}); } catch {}
  console.log('CF HEADERS:', req.headers);
  console.log('CF BODY:', raw);
  return res.status(200).json({ ok: true });
};
