/**
 * GET /api/discord/check-membership
 *
 * Cron-callable endpoint (run daily via Vercel Cron or external scheduler).
 * Finds NFT_Mints rows where Discord has NOT been linked yet and the row is
 * older than 7 days. Sends each customer a reminder email via console log
 * (wire up to your email provider — Resend, SendGrid, etc.).
 *
 * Vercel cron config (vercel.json):
 *   { "crons": [{ "path": "/api/discord/check-membership", "schedule": "0 9 * * *" }] }
 *
 * Required env vars:
 *   AIRTABLE_API_KEY, AIRTABLE_BASE_ID, DISCORD_INVITE_URL,
 *   DOMAIN, CRON_SECRET (optional header guard)
 */

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE ?? 'NFT_Mints';
const INVITE_URL = process.env.DISCORD_INVITE_URL ?? 'https://discord.gg/GdYRZtdvNS';
const DOMAIN = process.env.DOMAIN ?? 'https://yourdomain.com';
const CRON_SECRET = process.env.CRON_SECRET;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Fetch all NFT_Mints rows where Notes does NOT contain "Discord linked"
 * and Status is Sent or Minted.
 * @returns {Promise<Array<{ id: string, fields: Record<string, string> }>>}
 */
async function fetchUnlinkedRows() {
  const formula = encodeURIComponent(
    `AND(NOT(FIND("Discord linked",{Notes})),OR({Status}="Sent",{Status}="Minted"))`,
  );

  const fields = ['Customer Email', 'NFT Type', 'Status', 'Notes', 'Created Time', 'Name'];
  const fieldParams = fields.map((f) => `fields[]=${encodeURIComponent(f)}`).join('&');

  const url =
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}` +
    `?filterByFormula=${formula}&${fieldParams}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Airtable fetch failed [${res.status}]: ${body}`);
  }

  const data = await res.json();
  return data.records ?? [];
}

/**
 * Send a reminder email. Replace this stub with your actual email provider.
 * @param {{ email: string, name: string, nftType: string, inviteUrl: string }} opts
 */
async function sendReminderEmail({ email, name, nftType, inviteUrl }) {
  // TODO: replace with Resend / SendGrid / Postmark SDK call
  console.log(
    `[check-membership] Sending Discord reminder to ${email} (${nftType}) → ${inviteUrl}`,
  );

  // Example Resend snippet (uncomment when wired up):
  // const { Resend } = await import('resend');
  // const resend = new Resend(process.env.RESEND_API_KEY);
  // await resend.emails.send({
  //   from: 'Aurevon <noreply@blockt.io>',
  //   to: email,
  //   subject: 'Claim your Aurevon Discord role',
  //   html: `<p>Hi ${name},</p>
  //          <p>Your <strong>${nftType}</strong> NFT is waiting. Join our private Discord operator community:</p>
  //          <p><a href="${inviteUrl}">Claim Your Discord Role</a></p>`,
  // });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  // Optional: guard with a secret header so only the scheduler can call this
  if (CRON_SECRET && req.headers['x-cron-secret'] !== CRON_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  let rows;
  try {
    rows = await fetchUnlinkedRows();
  } catch (err) {
    console.error('check-membership Airtable error:', err.message);
    res.status(502).json({ error: 'Airtable fetch failed', detail: err.message });
    return;
  }

  const now = Date.now();
  const staleRows = rows.filter((row) => {
    const created = row.fields['Created Time'] ?? row.createdTime;
    if (!created) return false;
    return now - new Date(created).getTime() > SEVEN_DAYS_MS;
  });

  const results = [];

  for (const row of staleRows) {
    const email = row.fields['Customer Email'];
    const name = row.fields['Name'] ?? email;
    const nftType = row.fields['NFT Type'] ?? 'Aurevon NFT';

    if (!email) continue;

    // Build personalized auth link for the reminder
    const { signState } = await import('./lib/sign.js');
    const state = signState(email.toLowerCase().trim());
    const authUrl = `${DOMAIN}/api/discord/auth?email=${encodeURIComponent(email)}`;

    try {
      await sendReminderEmail({ email, name, nftType, inviteUrl: authUrl });
      results.push({ email, status: 'sent' });
    } catch (err) {
      console.error(`Failed to send reminder to ${email}:`, err.message);
      results.push({ email, status: 'error', error: err.message });
    }
  }

  res.status(200).json({
    checked: rows.length,
    stale: staleRows.length,
    reminded: results.length,
    results,
  });
}
