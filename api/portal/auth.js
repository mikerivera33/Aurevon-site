// api/portal/auth.js — Magic link email sender
// POST { email } → validates customer, generates token, sends magic link via Resend

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = req.body || {};

  // Validate email format
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email address required' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'app00c03021ILsOrv';
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'hello@aurevongroup.com';
  const BASE_URL = process.env.BASE_URL || 'https://aurevon-site.vercel.app';

  // If Airtable is not configured, return a helpful error
  if (!AIRTABLE_PAT) {
    console.error('AIRTABLE_PAT environment variable is not set');
    return res.status(500).json({ 
      error: 'Portal not yet configured. Please contact support at hello@aurevongroup.com' 
    });
  }

  const airtableHeaders = {
    Authorization: `Bearer ${AIRTABLE_PAT}`,
    'Content-Type': 'application/json',
  };

  // Search a table for customer email
  async function searchTable(tableId, emailField = 'Email') {
    try {
      const formula = encodeURIComponent(`LOWER({${emailField}})="${normalizedEmail}"`);
      const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableId}?filterByFormula=${formula}&maxRecords=1`;
      const resp = await fetch(url, { headers: airtableHeaders });
      if (!resp.ok) {
        console.error(`Airtable searchTable error [${tableId}]:`, await resp.text());
        return [];
      }
      const data = await resp.json();
      return data.records || [];
    } catch (e) {
      console.error(`searchTable exception [${tableId}]:`, e);
      return [];
    }
  }

  try {
    // Check if customer exists in Leads or Payments
    const [leadRecords, paymentRecords] = await Promise.all([
      searchTable('tblDuezyOsxy7sNES'),
      searchTable('tblMPOjy7os3FyO3Q'),
    ]);

    const isCustomer = leadRecords.length > 0 || paymentRecords.length > 0;
    if (!isCustomer) {
      return res.status(404).json({ error: 'No purchase found for that email address' });
    }

    // Try to get customer name from records
    let customerName = '';
    if (leadRecords[0]?.fields?.Name) customerName = leadRecords[0].fields.Name;
    else if (paymentRecords[0]?.fields?.Name) customerName = paymentRecords[0].fields.Name;
    else if (paymentRecords[0]?.fields?.['Customer Name']) customerName = paymentRecords[0].fields['Customer Name'];

    // Generate magic token
    const token = crypto.randomUUID();
    const tokenExpires = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    // Upsert CustomerAuth record
    const authRecords = await searchTable('tbl1UGOLPxZRW7vB2');
    if (authRecords.length > 0) {
      const recordId = authRecords[0].id;
      const existingName = authRecords[0].fields?.['Customer Name'];
      await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/tbl1UGOLPxZRW7vB2/${recordId}`, {
        method: 'PATCH',
        headers: airtableHeaders,
        body: JSON.stringify({
          fields: {
            'Magic Token': token,
            'Token Expires': tokenExpires,
            'Session Active': false,
            ...(existingName ? {} : { 'Customer Name': customerName }),
          },
        }),
      });
      if (!customerName && existingName) customerName = existingName;
    } else {
      await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/tbl1UGOLPxZRW7vB2`, {
        method: 'POST',
        headers: airtableHeaders,
        body: JSON.stringify({
          fields: {
            Email: normalizedEmail,
            'Customer Name': customerName,
            'Magic Token': token,
            'Token Expires': tokenExpires,
            'Session Active': false,
          },
        }),
      });
    }

    // Send magic link email via Resend
    const greeting = customerName ? `Hey ${customerName.split(' ')[0]},` : 'Hey there,';
    const magicLink = `${BASE_URL}/portal?token=${token}&email=${encodeURIComponent(normalizedEmail)}`;
    const emailHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{margin:0;padding:0;background:#0A0A0A;font-family:'DM Sans',Arial,sans-serif;color:#f0ede8;}.wrap{max-width:560px;margin:40px auto;background:#111827;border-radius:16px;overflow:hidden;}.header{background:linear-gradient(135deg,#1E3A8A,#3B82F6);padding:32px 40px;text-align:center;}.header h1{margin:0;font-size:28px;font-weight:900;color:#fff;letter-spacing:-0.5px;}.body{padding:40px;}.greeting{font-size:18px;color:#f0ede8;margin-bottom:16px;}.msg{font-size:15px;color:#b8b3ab;line-height:1.6;margin-bottom:32px;}.btn{display:block;background:linear-gradient(135deg,#1E3A8A,#3B82F6);color:#fff;text-decoration:none;text-align:center;padding:18px 32px;border-radius:10px;font-size:17px;font-weight:700;letter-spacing:0.3px;margin-bottom:24px;}.note{font-size:13px;color:#6b6760;text-align:center;line-height:1.5;}.footer{border-top:1px solid #2a2a2e;padding:24px 40px;text-align:center;}.footer p{font-size:12px;color:#6b6760;margin:0;}</style></head><body><div class="wrap"><div class="header"><h1>Aurevon</h1></div><div class="body"><p class="greeting">${greeting}</p><p class="msg">Click the button below to access your Aurevon Dashboard. Your deal statuses, NFTs, and purchase history are all inside.</p><a href="${magicLink}" class="btn">Open My Dashboard &rarr;</a><p class="note">This link expires in 15 minutes. If you didn't request this, you can safely ignore this email.</p></div><div class="footer"><p>Aurevon Group LLC &middot; <a href="mailto:hello@aurevongroup.com" style="color:#6b6760;">hello@aurevongroup.com</a></p></div></div></body></html>`;

    if (RESEND_API_KEY) {
      const emailResp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: RESEND_FROM_EMAIL,
          to: normalizedEmail,
          subject: 'Your Aurevon Dashboard login link',
          html: emailHtml,
        }),
      });
      if (!emailResp.ok) {
        const errText = await emailResp.text();
        console.error('Resend error:', errText);
      }
    } else {
      console.warn('RESEND_API_KEY not set — email not sent. Token:', token);
    }

    return res.status(200).json({ sent: true });
  } catch (err) {
    console.error('auth.js error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
