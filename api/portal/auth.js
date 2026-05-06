// api/portal/auth.js — Magic link email sender for Aurevon Operations
// POST { email } → validates customer in Airtable, generates token, sends magic link via Resend
// Airtable Base: appI9X8vcRcK1QZ1l (Aurevon Operations)
// Tables: Leads (tbllVIcSRXdZwofbs), Payments (tbl6KlhM9fIH19W5i), CustomerAuth (tblbCS7TL65FcOiWn)

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
  // Aurevon Operations base ID
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'appI9X8vcRcK1QZ1l';
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'hello@aurevongroup.com';
  const BASE_URL = process.env.BASE_URL || 'https://www.aurevonvc.com';

  // Aurevon Operations table IDs
  const LEADS_TABLE = 'tbllVIcSRXdZwofbs';
  const PAYMENTS_TABLE = 'tbl6KlhM9fIH19W5i';
  const AUTH_TABLE = 'tblbCS7TL65FcOiWn';

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
    // Check if customer exists in Leads or Payments tables
    const [leadRecords, paymentRecords] = await Promise.all([
      searchTable(LEADS_TABLE, 'Email'),
      searchTable(PAYMENTS_TABLE, 'Email'),
    ]);

    const isCustomer = leadRecords.length > 0 || paymentRecords.length > 0;

    if (!isCustomer) {
      return res.status(404).json({ error: 'No purchase found for that email address' });
    }

    // Try to get customer name from records
    let customerName = '';
    if (leadRecords[0]?.fields?.Name) customerName = leadRecords[0].fields.Name;
    else if (paymentRecords[0]?.fields?.['Customer Name']) customerName = paymentRecords[0].fields['Customer Name'];
    else if (paymentRecords[0]?.fields?.Name) customerName = paymentRecords[0].fields.Name;

    // Get service product for personalization
    const serviceProduct = paymentRecords[0]?.fields?.['Service Product'] || '';

    // Generate magic token
    const token = crypto.randomUUID();
    const tokenExpires = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    // Upsert CustomerAuth record
    const authRecords = await searchTable(AUTH_TABLE, 'Email');
    if (authRecords.length > 0) {
      const recordId = authRecords[0].id;
      const existingName = authRecords[0].fields?.['Customer Name'];
      await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AUTH_TABLE}/${recordId}`, {
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
      await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AUTH_TABLE}`, {
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
    const firstName = customerName ? customerName.split(' ')[0] : '';
    const greeting = firstName ? `Hey ${firstName},` : 'Hey there,';
    const magicLink = `${BASE_URL}/portal?token=${token}&email=${encodeURIComponent(normalizedEmail)}`;

    const emailHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0;padding:0;background:#0A0A0A;font-family:'DM Sans',Arial,sans-serif;color:#f0ede8;"><div style="max-width:560px;margin:40px auto;background:#111827;border-radius:16px;overflow:hidden;"><div style="background:linear-gradient(135deg,#1E3A8A,#3B82F6);padding:32px 40px;text-align:center;"><h1 style="margin:0;font-size:28px;font-weight:900;color:#fff;letter-spacing:-0.5px;">Aurevon</h1><p style="margin:8px 0 0;color:rgba(255,255,255,0.8);font-size:13px;letter-spacing:2px;">SYSTEMS. CAPITAL. INFRASTRUCTURE.</p></div><div style="padding:40px;"><p style="font-size:18px;color:#f0ede8;margin-bottom:16px;">${greeting}</p><p style="font-size:15px;color:#b8b3ab;line-height:1.6;margin-bottom:32px;">Click the button below to access your Aurevon Member Dashboard. Your deal statuses, NFT access, and purchase history are all inside.</p><a href="${magicLink}" style="display:block;background:linear-gradient(135deg,#1E3A8A,#3B82F6);color:#fff;text-decoration:none;text-align:center;padding:18px 32px;border-radius:10px;font-size:17px;font-weight:700;letter-spacing:0.3px;margin-bottom:24px;">Open My Aurevon Dashboard →</a><p style="font-size:13px;color:#6b6760;text-align:center;line-height:1.5;">This link expires in 15 minutes and can only be used once.<br>If you didn't request this, you can safely ignore this email.</p></div><div style="border-top:1px solid #2a2a2e;padding:24px 40px;text-align:center;"><p style="font-size:12px;color:#6b6760;margin:0;">Aurevon Group LLC &middot; Systems. Capital. Infrastructure.<br><a href="mailto:hello@aurevongroup.com" style="color:#3B82F6;">hello@aurevongroup.com</a></p></div></div></body></html>`;

    if (RESEND_API_KEY) {
      const emailResp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
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
