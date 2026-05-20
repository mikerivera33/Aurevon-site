/**
 * Unified portal handler — /api/portal/data?action=auth|verify|data
 *
 * action=auth  (POST { email })               → send magic-link login email via Resend
 * action=verify (POST { email, token })       → verify token, activate session, return sessionToken
 * action=data  (POST { email, sessionToken }) → validate session, return customer data
 *
 * Consolidated from portal/auth.js + portal/verify.js + portal/data.js
 * to stay under the Vercel Hobby 12-function limit.
 */

import crypto from 'node:crypto';

const DOMAIN = process.env.DOMAIN ?? 'https://www.aurevonvc.com';
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID ?? 'appI9X8vcRcK1QZ1l';
const AUTH_TABLE = process.env.AIRTABLE_TABLE_CUSTOMER_AUTH ?? 'tblbCS7TL65FcOiWn';
const PAYMENTS_TABLE = process.env.AIRTABLE_TABLE_PAYMENTS ?? 'tbl6KlhM9fIH19W5i';
const NFT_TABLE = process.env.AIRTABLE_TABLE_NFT_MINTS ?? 'tbliXEGJdoEIAJU06';
const MEMBERS_TABLE = process.env.AIRTABLE_TABLE_MEMBERS ?? 'tblYPn7hxnrgH723B';

function getAirtableHeaders() {
    const pat = process.env.AIRTABLE_PAT ?? process.env.AIRTABLE_API_KEY;
    if (!pat) throw new Error('Missing AIRTABLE_PAT env var');
    return { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' };
}

async function fetchRecords(tableId, formula, fields = []) {
    try {
          const params = new URLSearchParams({ filterByFormula: formula, maxRecords: '100' });
          for (const f of fields) params.append('fields[]', f);
          const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableId}?${params}`;
          const resp = await fetch(url, { headers: getAirtableHeaders() });
          if (!resp.ok) { console.error(`Airtable fetch [${tableId}]:`, await resp.text()); return []; }
          return (await resp.json()).records ?? [];
    } catch (e) { console.error(`fetchRecords [${tableId}]:`, e); return []; }
}

async function upsertAuthRecord(normalizedEmail, fields) {
    const existing = await fetchRecords(AUTH_TABLE, `LOWER({Email})="${normalizedEmail}"`);
    if (existing.length > 0) {
          const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AUTH_TABLE}/${existing[0].id}`;
          const r = await fetch(url, { method: 'PATCH', headers: getAirtableHeaders(), body: JSON.stringify({ fields }) });
          if (!r.ok) throw new Error(`Airtable PATCH (${r.status}): ${await r.text()}`);
          return r.json();
    } else {
          const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AUTH_TABLE}`;
          const r = await fetch(url, { method: 'POST', headers: getAirtableHeaders(), body: JSON.stringify({ fields: { Email: normalizedEmail, ...fields } }) });
          if (!r.ok) throw new Error(`Airtable POST (${r.status}): ${await r.text()}`);
          return r.json();
    }
}

// ── Route: auth ──────────────────────────────────────────────────────────────

async function handleAuth(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { email } = req.body ?? {};
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return res.status(400).json({ error: 'A valid email address is required.' });
    }
    const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
    if (!AIRTABLE_PAT) return res.status(500).json({ error: 'Portal not yet configured' });
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const RESEND_FROM = process.env.RESEND_FROM_EMAIL ?? 'noreply@aurevongroup.com';

  const normalizedEmail = email.trim().toLowerCase();
    if (normalizedEmail.includes('"') || normalizedEmail.includes("'")) {
          return res.status(400).json({ error: 'Invalid email format' });
    }

  try {
        // Cooldown: check if a link was issued < 1 minute ago
      const existing = await fetchRecords(AUTH_TABLE, `LOWER({Email})="${normalizedEmail}"`);
        if (existing.length > 0) {
                const expiry = existing[0].fields['Token Expiry'];
                if (expiry && (new Date(expiry).getTime() - Date.now()) > 29 * 60 * 1000) {
                          return res.status(200).json({ ok: true, message: 'A login link was recently sent. Please check your email.' });
                }
        }

      const token = crypto.randomBytes(32).toString('hex');
        const expiryTs = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        await upsertAuthRecord(normalizedEmail, { 'Magic Link Token': token, 'Token Expiry': expiryTs, 'Used': false, 'Session Active': false });

      const magicLink = `${DOMAIN}/portal?token=${token}&email=${encodeURIComponent(normalizedEmail)}`;
        const emailHtml = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Your Aurevon Portal Login Link</title></head><body style="margin:0;padding:0;background-color:#0a0a0a;font-family:'Segoe UI',Arial,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a0a;padding:40px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#111111;border:1px solid #2a2a2a;border-radius:12px;overflow:hidden;"><tr><td style="background:linear-gradient(135deg,#1a1a1a 0%,#0d0d0d 100%);padding:40px 48px;border-bottom:1px solid #c9a84c;"><h1 style="margin:0;font-size:28px;font-weight:700;color:#c9a84c;letter-spacing:2px;text-transform:uppercase;">AUREVON</h1><p style="margin:8px 0 0;font-size:13px;color:#888;letter-spacing:1px;text-transform:uppercase;">Investor &amp; Member Portal</p></td></tr><tr><td style="padding:48px;"><p style="margin:0 0 16px;font-size:16px;color:#cccccc;line-height:1.6;">Hello,</p><p style="margin:0 0 32px;font-size:16px;color:#cccccc;line-height:1.6;">You requested a login link for the Aurevon member portal. Click the button below to access your account. This link expires in <strong style="color:#c9a84c;">30 minutes</strong>.</p><table cellpadding="0" cellspacing="0" style="margin:0 auto 32px;"><tr><td style="background:linear-gradient(135deg,#c9a84c,#e8c86d);border-radius:8px;"><a href="${magicLink}" style="display:inline-block;padding:16px 40px;font-size:16px;font-weight:700;color:#0a0a0a;text-decoration:none;letter-spacing:0.5px;">Access My Portal</a></td></tr></table><p style="margin:0 0 8px;font-size:13px;color:#666;line-height:1.6;">Or copy this link into your browser:</p><p style="margin:0 0 32px;font-size:12px;color:#888;word-break:break-all;background:#1a1a1a;padding:12px;border-radius:6px;border:1px solid #2a2a2a;">${magicLink}</p><p style="margin:0;font-size:13px;color:#555;line-height:1.6;">If you did not request this link, you can safely ignore this email.</p></td></tr><tr><td style="background:#0d0d0d;padding:24px 48px;border-top:1px solid #1a1a1a;"><p style="margin:0;font-size:12px;color:#444;text-align:center;">&copy; ${new Date().getFullYear()} Aurevon Group. All rights reserved.<br/><a href="${DOMAIN}" style="color:#c9a84c;text-decoration:none;">${DOMAIN.replace('https://', '')}</a></p></td></tr></table></td></tr></table></body></html>`;

      if (!RESEND_API_KEY) {
              console.error('[Portal auth] RESEND_API_KEY not set — email not sent');
              return res.status(500).json({ error: 'Email service not configured' });
      }
        const resendResp = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: RESEND_FROM, to: normalizedEmail, subject: 'Your Aurevon Portal Login Link', html: emailHtml }),
        });
        if (!resendResp.ok) {
                console.error('[Portal auth] Resend error:', await resendResp.text());
                return res.status(500).json({ error: 'Failed to send login email. Please try again.' });
        }
        return res.status(200).json({ ok: true, message: 'Check your email for a login link.' });
  } catch (err) {
        console.error('[Portal auth] error:', err);
        return res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Route: verify ─────────────────────────────────────────────────────────────

async function handleVerify(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { email, token } = req.body ?? {};
    if (!email || !token) return res.status(400).json({ error: 'Email and token are required.' });
    if (!process.env.AIRTABLE_PAT) return res.status(500).json({ error: 'Portal not yet configured' });

  const normalizedEmail = email.trim().toLowerCase();
    const INVALID_MSG = 'Invalid or expired login link. Please request a new one.';

  try {
        const records = await fetchRecords(AUTH_TABLE, `LOWER({Email})="${normalizedEmail}"`);
        if (records.length === 0) return res.status(401).json({ error: INVALID_MSG });

      const record = records[0];
        const fields = record.fields;
        const storedToken = fields['Magic Link Token'] ?? '';

      // Timing-safe comparison
      if (storedToken.length !== token.length) return res.status(401).json({ error: INVALID_MSG });
        if (!crypto.timingSafeEqual(Buffer.from(storedToken, 'utf8'), Buffer.from(token, 'utf8'))) {
                return res.status(401).json({ error: INVALID_MSG });
        }
        if (fields['Used'] === true) return res.status(401).json({ error: INVALID_MSG });
        if (!fields['Token Expiry'] || new Date(fields['Token Expiry']) <= new Date()) {
                return res.status(401).json({ error: INVALID_MSG });
        }

      const sessionToken = crypto.randomBytes(32).toString('hex');
        const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AUTH_TABLE}/${record.id}`;
        const updateResp = await fetch(url, {
                method: 'PATCH',
                headers: getAirtableHeaders(),
                body: JSON.stringify({ fields: { 'Used': true, 'Session Active': true, 'Session Token': sessionToken } }),
        });
        if (!updateResp.ok) {
                console.error('[Portal verify] Airtable update error:', await updateResp.text());
                return res.status(500).json({ error: 'Failed to activate session. Please try again.' });
        }
        return res.status(200).json({ ok: true, email: normalizedEmail, sessionToken });
  } catch (err) {
        console.error('[Portal verify] error:', err);
        return res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Route: data ───────────────────────────────────────────────────────────────

async function handleData(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { email, sessionToken } = req.body ?? {};
    if (!email || !sessionToken) return res.status(401).json({ error: 'Authentication required' });
    if (!process.env.AIRTABLE_PAT) return res.status(500).json({ error: 'Portal not yet configured' });

  const normalizedEmail = email.trim().toLowerCase();
    if (normalizedEmail.includes('"') || normalizedEmail.includes("'")) {
          return res.status(400).json({ error: 'Invalid email format' });
    }

  try {
        const authRecords = await fetchRecords(AUTH_TABLE, `LOWER({Email})="${normalizedEmail}"`);
        if (authRecords.length === 0) return res.status(401).json({ error: 'Session not found' });

      const authFields = authRecords[0].fields;
        const storedToken = authFields['Session Token'] ?? authFields['Magic Link Token'] ?? '';
        if (!authFields['Session Active'] || !storedToken ||
                    storedToken.length !== sessionToken.length ||
                    !crypto.timingSafeEqual(Buffer.from(storedToken, 'utf8'), Buffer.from(sessionToken, 'utf8'))) {
                return res.status(401).json({ error: 'Session expired. Please log in again.' });
        }

      const emailFormula = `LOWER({Email})="${normalizedEmail}"`;
        const [paymentRecords, nftRecords, memberRecords] = await Promise.all([
                fetchRecords(PAYMENTS_TABLE, emailFormula),
                fetchRecords(NFT_TABLE, emailFormula),
                fetchRecords(MEMBERS_TABLE, emailFormula),
              ]);

      const payments = paymentRecords.map(r => ({
              id: r.id,
              serviceProduct: r.fields['Service Product'] ?? '',
              amount: r.fields['Amount'] ?? r.fields['amount'] ?? 0,
              status: r.fields['Status'] ?? r.fields['status'] ?? '',
              deliverableStatus: r.fields['Deliverable Status'] ?? 'Not Started',
              deliveryNotes: r.fields['Delivery Notes'] ?? '',
              paymentDate: r.fields['Payment Date'] ?? '',
              paymentProvider: r.fields['Payment Provider'] ?? r.fields['payment_provider'] ?? '',
      }));

      const nfts = nftRecords.map(r => ({
              id: r.id,
              nftType: r.fields['NFT Type'] ?? '',
              tokenId: r.fields['Token ID'] ?? '',
              mintStatus: r.fields['Mint Status'] ?? 'Pending',
              discordRoleAssigned: r.fields['Discord Synced'] ?? false,
              mintDate: r.fields['Mint Date'] ?? '',
              transactionHash: r.fields['Transaction Hash'] ?? '',
      }));

      const member = memberRecords[0]?.fields ?? {};
        const customerName = authFields['Customer Name'] ?? member['Customer Name'] ?? '';
        const memberTier = authFields['Member Tier'] ?? member['Member Tier'] ?? 'Free';

      return res.status(200).json({
              success: true,
              profile: {
                        email: normalizedEmail, customerName, memberTier,
                        joinDate: member['Join Date'] ?? '',
                        active: member['Active'] ?? false,
                        discordUsername: member['Discord Username'] ?? '',
                        nftHoldings: member['NFT Holdings'] ?? '',
              },
              payments,
              nfts,
              summary: {
                        totalPayments: payments.length,
                        activeNFTs: nfts.filter(n => n.mintStatus === 'Minted').length,
                        pendingDeliverables: payments.filter(p => ['Not Started', 'In Progress'].includes(p.deliverableStatus)).length,
              },
      });
  } catch (err) {
        console.error('[Portal data] error:', err);
        return res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', DOMAIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query?.action ?? 'data';

  switch (action) {
    case 'auth':   return handleAuth(req, res);
    case 'verify': return handleVerify(req, res);
    case 'data':   return handleData(req, res);
    default:
            return res.status(400).json({
                      error: 'Invalid action param',
                      valid: ['auth', 'verify', 'data'],
            });
  }
}
