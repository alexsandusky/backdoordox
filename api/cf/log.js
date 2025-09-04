// /api/cf/log.js
export default function handler(req, res) {
  if (req.method === 'GET') {
    // Respond to ClickFunnels "Save Webhook" test (could be GET request)
    return res.status(200).send('OK');  // simple confirmation response
  }
  if (req.method === 'HEAD') {
    // Respond to HEAD requests with no body
    return res.status(200).end();
  }
  if (req.method === 'POST') {
    // Handle the actual webhook payload
    const payload = req.body;  // Vercel parses JSON body automatically:contentReference[oaicite:2]{index=2}
    console.log('ClickFunnels webhook payload:', payload);
    // TODO: add your processing logic here (e.g., save to database)
    return res.status(200).json({ received: true });
  }
  // For any other HTTP methods, return 405 Method Not Allowed
  res.setHeader('Allow', ['GET','HEAD','POST']);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}
