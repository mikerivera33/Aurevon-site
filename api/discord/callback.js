/**
 * GET /api/discord/callback?code=xxx&state=xxx
 *
 * Discord OAuth2 callback handler.
 * Flow:
 *   1. Verify state HMAC → extract email
 *   2. Exchange code for Discord access token
 *   3. Fetch Discord user info
 *   4. Look up NFT in Airtable by email
 *   5. Resolve Discord role from NFT type
 *   6. Add user to guild (or assign role if already member)
 *   7. Update Airtable row with Discord user ID
 *   8. Redirect to success page
 *
 * Required env vars:
 *   DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN,
 *   DISCORD_GUILD_ID, DISCORD_ROLE_*, AIRTABLE_API_KEY,
 *   AIRTABLE_BASE_ID, STATE_SECRET, DOMAIN
 */

import { verifyState } from './lib/sign.js';
import { exchangeCode, getUser, addMemberToGuild, assignRole } from './lib/discord.js';
import { getRoleId } from './lib/role-map.js';

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE ?? 'NFT_Mints';
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const DOMAIN = process.env.DOMAIN ?? 'https://yourdomain.com';

// ---------------------------------------------------------------------------
// Airtable helpers
// ---------------------------------------------------------------------------

/**
 * Look up NFT_Mints rows for an email with Status IN (Sent, Minted).
 * Returns { recordId, nftType } or null if not found.
 * @param {string} email
 * @returns {Promise<{ recordId: string, nftType: string } | null>}
 */
async function lookupNft(email) {
  const formula = encodeURIComponent(
    `AND({Customer Email}="${email}",OR({Status}="Sent",{Status}="Minted"))`,
  );

  const url =
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}` +
    `?filterByFormula=${formula}&maxRecords=1&fields[]=NFT+Type&fields[]=Status`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Airtable lookup failed [${res.status}]: ${body}`);
  }

  const data = await res.json();
  const record = data.records?.[0];
  if (!record) return null;

  return {
    recordId: record.id,
    nftType: record.fields['NFT Type'] ?? '',
  };
}

/**
 * Update an Airtable record: set Notes to "Discord linked: <userId>"
 * and Status to "Minted".
 * @param {string} recordId
 * @param {string} userId
 */
async function updateAirtableRecord(recordId, userId) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}/${recordId}`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fields: {
        Notes: `Discord linked: ${userId}`,
        Status: 'Minted',
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Non-fatal — log but don't block the user
    console.error(`Airtable update failed [${res.status}]: ${body}`);
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  const { code, state, error: oauthError } = req.query ?? {};

  // Discord can redirect with ?error if user denied
  if (oauthError) {
    res.redirect(302, `${DOMAIN}/discord-welcome.html?error=denied`);
    return;
  }

  if (!code || !state) {
    res.status(400).json({ error: 'Missing code or state param' });
    return;
  }

  let email;
  try {
    email = verifyState(state);
  } catch (err) {
    res.status(403).json({ error: 'Invalid state parameter', detail: err.message });
    return;
  }

  let discordToken, discordUser;
  try {
    discordToken = await exchangeCode(code);
    discordUser = await getUser(discordToken.access_token);
  } catch (err) {
    console.error('Discord auth error:', err.message);
    res.status(502).json({ error: 'Discord authentication failed', detail: err.message });
    return;
  }

  const userId = discordUser.id;

  // Look up NFT in Airtable
  let nftRecord;
  try {
    nftRecord = await lookupNft(email);
  } catch (err) {
    console.error('Airtable error:', err.message);
    res.status(502).json({ error: 'NFT lookup failed', detail: err.message });
    return;
  }

  if (!nftRecord) {
    // No matching NFT — send to informational page
    res.redirect(302, `${DOMAIN}/no-nft.html`);
    return;
  }

  const { recordId, nftType } = nftRecord;
  const roleId = getRoleId(nftType);

  if (!roleId) {
    console.error(`No role mapping for NFT type: "${nftType}"`);
    res.status(500).json({ error: `Unknown NFT type: ${nftType}` });
    return;
  }

  // Add user to guild (handles both new + existing members)
  try {
    await addMemberToGuild(userId, discordToken.access_token, [roleId]);
  } catch (err) {
    // If add-to-guild fails (e.g. user already in server but PUT returned 204),
    // fall through and attempt role assignment directly.
    console.warn('addMemberToGuild warning:', err.message);
  }

  // Explicitly assign role to ensure it lands (handles existing members)
  try {
    await assignRole(userId, roleId);
  } catch (err) {
    console.error('Role assignment error:', err.message);
    res.status(502).json({ error: 'Role assignment failed', detail: err.message });
    return;
  }

  // Update Airtable record asynchronously (non-blocking for UX)
  updateAirtableRecord(recordId, userId).catch((err) =>
    console.error('Airtable update error:', err.message),
  );

  const nftTypeEncoded = encodeURIComponent(nftType);
  res.redirect(
    302,
    `${DOMAIN}/discord-welcome.html?role=${nftTypeEncoded}&server=${GUILD_ID}`,
  );
}
