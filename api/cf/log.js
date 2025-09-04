// CommonJS; tolerant to any method/body/content-type
module.exports = async (req, res) => {
  // allow CF "save" probes of any kind
  if (req.method !== 'POST') return res.status(200).send('ok');

  // read raw body (handles JSON or form-encoded)
  let raw = '';
  for await (const chunk of req) raw += chunk;

  // try to parse JSON; if not, try urlencoded; else keep raw
  let payload = raw;
  try { payload = JSON.parse(raw); }
  catch {
    try {
      const p = new URLSearchParams(raw); 
      payload = Object.fromEntries(p.entries());
    } catch {}
  }

  console.log('CF HEADERS:', req.headers);
  console.log('CF BODY:', payload);
  res.status(200).json({ ok: true });
};
