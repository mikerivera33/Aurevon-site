// api/portal/verify.js — Token verification endpoint
// POST { email, token } → validates magic link token, returns sessionToken

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, token } = req.body || {};

  if (!email || !token) {
    return res.status(400).json({ valid: false, reason: 'Email and token are required' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'app00c03021ILsOrv';

  if (!AIRTABLE_PAT) {
    return res.status(500).json({ valid: false, reason: 'Server configuration error' });
  }

  const airtableHeaders = {
    Authorization: `Bearer ${AIRTABLE_PAT}`,
    'Content-Type': 'application/json',
  };

  try {
    // Search CustomerAuth for this email
    const formula = encodeURIComponent(`LOWER({Email})="${normalizedEmail}"`);
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/tbl1UGOLPxZRW7vB2?filterByFormula=${formula}&maxRecords=1`;
    const resp = await fetch(url, { headers: airtableHeaders });
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
    if (!tokenExpires || new Date(tokenExpires) < new Date()) {
      return res.status(200).json({ valid: false, reason: 'Login link has expired. Please request a new one.' });
    }

    // Generate session token
    const sessionToken = crypto.randomUUID();
    const now = new Date().toISOString();

    // Update CustomerAuth — mark session active, clear magic token, record last login
    await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/tbl1UGOLPxZRW7vB2/${record.id}`, {
      method: 'PATCH',
      headers: airtableHeaders,
      body: JSON.stringify({
        fields: {
          'Session Token': sessionToken,
          'Session Active': true,
          'Last Login': now,
          'Magic Token': '',
          'Token Expires': '',
        },
      }),
    });

    const customerName = fields['Customer Name'] || '';

    return res.status(200).json({
      valid: true,
      sessionToken,
      customerName,
      email: normalizedEmail,
    });
  } catch (err) {
    console.error('verify.js error:', err);
    return res.status(500).json({ valid: false, reason: 'Internal server error' });
  }
}
