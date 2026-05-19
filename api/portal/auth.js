// api/portal/auth.js — Magic-link auth email sender for Aurevon Portal
// POST { email } → creates/updates CustomerAuth record, sends magic-link email via Resend

import crypto from 'crypto';

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

  const { email } = req.body || {};

  // Validate email
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }

  const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
  if (!AIRTABLE_PAT) {
    console.error('AIRTABLE_PAT environment variable is not set');
    return res.status(500).json({ error: 'Portal not yet configured' });
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const RESEND_FROM = process.env.RESEND_FROM_EMAIL ?? 'noreply@aurevongroup.com';

  const AIRTABLE_BASE_ID = 'appI9X8vcRcK1QZ1l';
  const AUTH_TABLE = 'tblbCS7TL65FcOiWn';
  const normalizedEmail = email.trim().toLowerCase();

  if (normalizedEmail.includes('"') || normalizedEmail.includes("'")) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  const airtableHeaders = {
    Authorization: `Bearer ${AIRTABLE_PAT}`,
    'Content-Type': 'application/json',
  };

  try {
    // Generate secure token
    const token = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 minutes

    // Look up existing CustomerAuth record
    const filterFormula = encodeURIComponent(`LOWER({Email})="${normalizedEmail}"`);
    const searchUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AUTH_TABLE}?filterByFormula=${filterFormula}&maxRecords=1`;
    const searchResp = await fetch(searchUrl, { headers: airtableHeaders });

    if (!searchResp.ok) {
      console.error('Airtable search error:', await searchResp.text());
      return res.status(500).json({ error: 'Failed to look up account. Please try again.' });
    }

    const searchData = await searchResp.json();
    const existingRecords = searchData.records || [];

    // Cooldown: if a link was issued within the last minute, don't send another
    if (existingRecords.length > 0) {
      const existingExpiry = existingRecords[0].fields['Token Expiry'];
      if (existingExpiry) {
        const expiryMs = new Date(existingExpiry).getTime();
        const msUntilExpiry = expiryMs - Date.now();
        // 30-minute expiry — if more than 29 minutes remain, link was issued < 1 minute ago
        if (msUntilExpiry > 29 * 60 * 1000) {
          return res.status(200).json({ ok: true, message: 'A login link was recently sent. Please check your email.' });
        }
      }
    }

    if (existingRecords.length > 0) {
      // Update existing record with new token
      const recordId = existingRecords[0].id;
      const updateUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AUTH_TABLE}/${recordId}`;
      const updateResp = await fetch(updateUrl, {
        method: 'PATCH',
        headers: airtableHeaders,
        body: JSON.stringify({
          fields: {
            'Magic Link Token': token,
            'Token Expiry': expiry,
            'Used': false,
            'Session Active': false,
          },
        }),
      });

      if (!updateResp.ok) {
        console.error('Airtable update error:', await updateResp.text());
        return res.status(500).json({ error: 'Failed to generate login link. Please try again.' });
      }
    } else {
      // Create new CustomerAuth record
      const createUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AUTH_TABLE}`;
      const createResp = await fetch(createUrl, {
        method: 'POST',
        headers: airtableHeaders,
        body: JSON.stringify({
          fields: {
            'Email': normalizedEmail,
            'Magic Link Token': token,
            'Token Expiry': expiry,
            'Used': false,
            'Session Active': false,
          },
        }),
      });

      if (!createResp.ok) {
        console.error('Airtable create error:', await createResp.text());
        return res.status(500).json({ error: 'Failed to create account. Please try again.' });
      }
    }

    // Send magic-link email via Resend
    const magicLink = `${DOMAIN}/portal?token=${token}&email=${encodeURIComponent(normalizedEmail)}`;

    const emailHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your Aurevon Portal Login Link</title>
</head>
<body style="margin:0;padding:0;background-color:#0a0a0a;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a0a;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#111111;border:1px solid #2a2a2a;border-radius:12px;overflow:hidden;">
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#1a1a1a 0%,#0d0d0d 100%);padding:40px 48px;border-bottom:1px solid #c9a84c;">
              <h1 style="margin:0;font-size:28px;font-weight:700;color:#c9a84c;letter-spacing:2px;text-transform:uppercase;">AUREVON</h1>
              <p style="margin:8px 0 0;font-size:13px;color:#888;letter-spacing:1px;text-transform:uppercase;">Investor &amp; Member Portal</p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:48px;">
              <p style="margin:0 0 16px;font-size:16px;color:#cccccc;line-height:1.6;">Hello,</p>
              <p style="margin:0 0 32px;font-size:16px;color:#cccccc;line-height:1.6;">
                You requested a login link for the Aurevon member portal. Click the button below to access your account. This link expires in <strong style="color:#c9a84c;">30 minutes</strong>.
              </p>
              <!-- CTA Button -->
              <table cellpadding="0" cellspacing="0" style="margin:0 auto 32px;">
                <tr>
                  <td style="background:linear-gradient(135deg,#c9a84c,#e8c86d);border-radius:8px;">
                    <a href="${magicLink}" style="display:inline-block;padding:16px 40px;font-size:16px;font-weight:700;color:#0a0a0a;text-decoration:none;letter-spacing:0.5px;">
                      Access My Portal
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 8px;font-size:13px;color:#666;line-height:1.6;">Or copy this link into your browser:</p>
              <p style="margin:0 0 32px;font-size:12px;color:#888;word-break:break-all;background:#1a1a1a;padding:12px;border-radius:6px;border:1px solid #2a2a2a;">
                ${magicLink}
              </p>
              <p style="margin:0;font-size:13px;color:#555;line-height:1.6;">
                If you did not request this link, you can safely ignore this email. No action is needed.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#0d0d0d;padding:24px 48px;border-top:1px solid #1a1a1a;">
              <p style="margin:0;font-size:12px;color:#444;text-align:center;">
                &copy; ${new Date().getFullYear()} Aurevon Group. All rights reserved.<br />
                <a href="${DOMAIN}" style="color:#c9a84c;text-decoration:none;">${DOMAIN.replace('https://', '')}</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const emailPayload = {
      from: RESEND_FROM,
      to: normalizedEmail,
      subject: 'Your Aurevon Portal Login Link',
      html: emailHtml,
    };

    const resendResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(emailPayload),
    });

    if (!resendResp.ok) {
      const resendError = await resendResp.text();
      console.error('Resend error:', resendError);
      return res.status(500).json({ error: 'Failed to send login email. Please try again.' });
    }

    return res.status(200).json({ ok: true, message: 'Check your email for a login link.' });

  } catch (err) {
    console.error('auth.js error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
