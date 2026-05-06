// api/portal/verify.js — Token verification endpoint for Aurevon Operations
// POST { email, token } → validates magic link token, activates session
// Airtable Base: appI9X8vcRcK1QZ1l (Aurevon Operations)
// CustomerAuth table: tblbCS7TL65FcOiWn

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

  const { email, token } = req.body || {};

  if (!email || !token) {
    return res.status(400).json({ valid: false, reason: 'Email and token are required' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
  // Aurevon Operations base ID
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'appI9X8vcRcK1QZ1l';
  // CustomerAuth table ID
  const AUTH_TABLE = 'tblbCS7TL65FcOiWn';

  if (!AIRTABLE_PAT) {
    console.error('AIRTABLE_PAT environment variable is not set');
    return res.status(500).json({ valid: false, reason: 'Portal not yet configured' });
  }

  const airtableHeaders = {
    Authorization: `Bearer ${AIRTABLE_PAT}`,
    'Content-Type': 'application/json',
  };

  try {
    // Search CustomerAuth table for this email
    const formula = encodeURIComponent(`LOWER({Email})="${normalizedEmail}"`);
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AUTH_TABLE}?filterByFormula=${formula}&maxRecords=1`;
    const resp = await fetch(url, { headers: airtableHeaders });

    if (!resp.ok) {
      console.error('Airtable verify lookup error:', await resp.text());
      return res.status(500).json({ valid: false, reason: 'Database error' });
    }

    const data = await resp.json();
    const records = data.records || [];

    if (records.length === 0) {
      return res.status(200).json({ valid: false, reason: 'No auth record found for that email' });
    }

    const record = records[0];
    const fields = record.fields;

    // Validate token
    if (!fields['Magic Token'] || fields['Magic Token'] !== token) {
      return res.status(200).json({ valid: false, reason: 'Invalid login link' });
    }

    // Check expiry
    const tokenExpires = fields['Token Expires'];
    if (tokenExpires && new Date(tokenExpires) < new Date()) {
      return res.status(200).json({ valid: false, reason: 'Login link has expired. Please request a new one.' });
    }

    // Mark session active and clear token (one-time use)
    const recordId = record.id;
    await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AUTH_TABLE}/${recordId}`, {
      method: 'PATCH',
      headers: airtableHeaders,
      body: JSON.stringify({
        fields: {
          'Session Active': true,
          'Magic Token': '',
          'Last Login': new Date().toISOString().split('T')[0],
        },
      }),
    });

    // Return customer info for dashboard
    return res.status(200).json({
      valid: true,
      customerName: fields['Customer Name'] || '',
      email: normalizedEmail,
      memberTier: fields['Member Tier'] || 'Free',
    });
  } catch (err) {
    console.error('verify.js error:', err);
    return res.status(500).json({ valid: false, reason: 'Internal server error' });
  }
}
