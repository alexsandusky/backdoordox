// /api/send.ts — Vercel Edge Function is fine, but use Node if you prefer
import type { VercelRequest, VercelResponse } from '@vercel/node';
import nodemailer from 'nodemailer';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method not allowed' });

  try {
    // Simple token in query (?token=XYZ)
    const token = String(req.query.token || '');
    if (!process.env.BRIDGE_TOKEN || token !== process.env.BRIDGE_TOKEN) {
      return res.status(401).json({ ok:false, error:'unauthorized' });
    }

    const { to, from, subject, text } = req.body || {};
    if (!to || !from || !subject || !text) {
      return res.status(400).json({ ok:false, error:'missing fields' });
    }

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: String(process.env.SMTP_SECURE || 'true') === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    const info = await transporter.sendMail({
      from,
      to,
      subject,
      text
    });

    return res.status(200).json({ ok:true, messageId: info.messageId });
  } catch (e:any) {
    console.error('SMTP bridge error:', e?.message || e);
    return res.status(500).json({ ok:false, error: e?.message || 'unknown' });
  }
}
