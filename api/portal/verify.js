// api/portal/verify.js — Magic-link token verifier for Aurevon Portal
// POST { email, token } → validates token against CustomerAuth, activates session

import crypto from 'node:crypto';

export default async function handler(req, res) {
  const DOMAIN = process.env.DOMAIN ?? 'https://www.aurevonvc.com';

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', DOMAIN);
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
    return res.status(400).json({ error: 'Email and token are required.' });
  }

  const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
  if (!AIRTABLE_PAT) {
    console.error('AIRTABLE_PAT environment variable is not set');
    return res.status(500).json({ error: 'Portal not yet configured' });
  }

  const AIRTABLE_BASE_ID = 'appI9X8vcRcK1QZ1l';
  const AUTH_TABLE = 'tblbCS7TL65FcOiWn';
  const normalizedEmail = email.trim().toLowerCase();
  const INVALID_MSG = 'Invalid or expired login link. Please request a new one.';

  const airtableHeaders = {
    Authorization: `Bearer ${AIRTABLE_PAT}`,
    'Content-Type': 'application/json',
  };

  try {
    // Look up CustomerAuth record by email
    const filterFormula = encodeURIComponent(`LOWER({Email})="${normalizedEmail}"`);
    const searchUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AUTH_TABLE}?filterByFormula=${filterFormula}&maxRecords=1`;
    const searchResp = await fetch(searchUrl, { headers: airtableHeaders });

    if (!searchResp.ok) {
      console.error('Airtable search error:', await searchResp.text());
      return res.status(500).json({ error: 'Failed to verify token. Please try again.' });
    }

    const searchData = await searchResp.json();
    const records = searchData.records || [];

    if (records.length === 0) {
      return res.status(401).json({ error: INVALID_MSG });
    }

    const record = records[0];
    const fields = record.fields;

    // Validate token matches exactly (timing-safe)
    const storedToken = fields['Magic Link Token'] ?? '';
    if (storedToken.length !== token.length || !crypto.timingSafeEqual(Buffer.from(storedToken, 'utf8'), Buffer.from(token, 'utf8'))) {
      return res.status(401).json({ error: INVALID_MSG });
    }

    // Validate token has not been used
    if (fields['Used'] === true) {
      return res.status(401).json({ error: INVALID_MSG });
    }

    // Validate token has not expired
    const expiry = fields['Token Expiry'];
    if (!expiry || new Date(expiry) <= new Date()) {
      return res.status(401).json({ error: INVALID_MSG });
    }

    // Generate a fresh session token
    const sessionToken = crypto.randomBytes(32).toString('hex');

    // Mark token as used, activate session, and store fresh session token
    const updateUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AUTH_TABLE}/${record.id}`;
    const updateResp = await fetch(updateUrl, {
      method: 'PATCH',
      headers: airtableHeaders,
      body: JSON.stringify({
        fields: {
          'Used': true,
          'Session Active': true,
          'Session Token': sessionToken,
        },
      }),
    });

    if (!updateResp.ok) {
      console.error('Airtable update error:', await updateResp.text());
      return res.status(500).json({ error: 'Failed to activate session. Please try again.' });
    }

    return res.status(200).json({
      ok: true,
      email: normalizedEmail,
      sessionToken,
    });

  } catch (err) {
    console.error('verify.js error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
