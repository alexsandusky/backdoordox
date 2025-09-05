import type { VercelRequest, VercelResponse } from '@vercel/node';
import nodemailer from 'nodemailer';

export const config = { runtime: 'nodejs18.x' };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(204).end();

  const token = String(req.query.token || '').trim();
  if (!process.env.BRIDGE_TOKEN || token !== process.env.BRIDGE_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, runtime: 'node', ready: true });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  let body: any = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  const to = String(body?.to || '').trim();
  const from = String(body?.from || '').trim();
  const subject = String(body?.subject || '').trim();
  const text = String(body?.text || '').trim();

  if (!to || !from || !subject || !text) {
    return res.status(400).json({ ok: false, error: 'missing fields' });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'mail.lendnet.io',
      port: Number(process.env.SMTP_PORT || 465),
      secure: String(process.env.SMTP_SECURE ?? 'true') === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    const info = await transporter.sendMail({ to, from, subject, text });

    return res.status(200).json({ ok: true, messageId: info.messageId });
  } catch (err: any) {
    console.error('SMTP bridge error:', err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || 'unknown' });
  }
}

/*
Health check:
GET https://<my-app>.vercel.app/api/send?token=XYZ

Send example:
curl -X POST "https://<my-app>.vercel.app/api/send?token=XYZ" \
  -H "content-type: application/json" \
  -d '{
    "to":"leads@lyftgrowth.com",
    "from":"Lendnet.io <sean@lendnet.io>",
    "subject":"[Lendnet.io] Test",
    "text":"Hello from the bridge"
  }'
*/
