/**
 * Unified Discord handler — GET /api/discord?action=auth|callback
 *
 * Consolidates OAuth flow into one serverless function to stay under
 * the Vercel Hobby plan's 12-function limit.
 *
 * Routes:
 *   ?action=auth&email=xxx   → redirect to Discord consent screen
 *   ?action=callback&code=x  → handle OAuth callback, assign role
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

// ── Env ──────────────────────────────────────────────────────────────────────
const CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const BOT_TOKEN     = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID      = process.env.DISCORD_GUILD_ID;
const DOMAIN        = process.env.DOMAIN ?? 'https://www.aurevonvc.com';
const STATE_SECRET  = process.env.STATE_SECRET ?? 'change-me-32-chars-placeholder!!';
const AIRTABLE_API_KEY = process.env.AIRTABLE_PAT ?? process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE   = process.env.AIRTABLE_TABLE ?? 'NFT_Mints';

const REDIRECT_URI     = `${DOMAIN}/api/discord?action=callback`;
const DISCORD_API      = 'https://discord.com/api/v10';
const DISCORD_OAUTH     = 'https://discord.com/api/oauth2/authorize';
const SCOPES           = 'identify guilds.join';

// ── NFT → Role mapping ──────────────────────────────────────────────────────
const NFT_ROLE_MAP = {
  'Aurevon Insider':            process.env.DISCORD_ROLE_INSIDER,
  'Aurevon Ember':              process.env.DISCORD_ROLE_EMBER,
  'Aurevon Obsidian Executive': process.env.DISCORD_ROLE_OBSIDIAN,
  '001 Genesis':               process.env.DISCORD_ROLE_GENESIS,
  '004 Chrome':                process.env.DISCORD_ROLE_CHROME,
};

// ── HMAC state helpers ───────────────────────────────────────────────────────
function signState(email) {
  const mac = createHmac('sha256', STATE_SECRET).update(email).digest('hex').slice(0, 16);
  return `${email}.${mac}`;
}

function verifyState(state) {
  const lastDot = state.lastIndexOf('.');
  if (lastDot === -1) throw new Error('Invalid state format');
  const email = state.slice(0, lastDot);
  const received = state.slice(lastDot + 1);
  const expected = createHmac('sha256', STATE_SECRET).update(email).digest('hex').slice(0, 16);
  const a = Buffer.from(received.padEnd(32, '0'));
  const b = Buffer.from(expected.padEnd(32, '0'));
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('State HMAC mismatch');
  return email;
}

// ── Discord API helpers ──────────────────────────────────────────────────────
async function discordError(res, ctx) {
  const body = await res.text().catch(() => '');
  throw new Error(`Discord ${ctx} [${res.status}]: ${body}`);
}

async function exchangeCode(code) {
  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI,
    }).toString(),
  });
  if (!res.ok) await discordError(res, 'token exchange');
  return res.json();
}

async function getUser(accessToken) {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) await discordError(res, 'get user');
  return res.json();
}

async function addMemberToGuild(userId, accessToken, roleIds) {
  const res = await fetch(`${DISCORD_API}/guilds/${GUILD_ID}/members/${userId}`, {
    method: 'PUT',
    headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: accessToken, roles: roleIds }),
  });
  if (![200, 201, 204].includes(res.status)) await discordError(res, 'add to guild');
}

async function assignRole(userId, roleId) {
  const res = await fetch(`${DISCORD_API}/guilds/${GUILD_ID}/members/${userId}/roles/${roleId}`, {
    method: 'PUT',
    headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (res.status !== 204) await discordError(res, 'assign role');
}

// ── Airtable helpers ─────────────────────────────────────────────────────────
async function lookupNft(email) {
  const formula = encodeURIComponent(
    `AND({Customer Email}="${email}",OR({Status}="Sent",{Status}="Minted"))`,
  );
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}?filterByFormula=${formula}&maxRecords=1&fields[]=NFT+Type&fields[]=Status`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
  if (!res.ok) { const b = await res.text().catch(() => ''); throw new Error(`Airtable [${res.status}]: ${b}`); }
  const data = await res.json();
  const rec = data.records?.[0];
  return rec ? { recordId: rec.id, nftType: rec.fields['NFT Type'] ?? '' } : null;
}

async function updateAirtableRecord(recordId, userId) {
  await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}/${recordId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { Notes: `Discord linked: ${userId}`, Status: 'Minted' } }),
  }).catch(err => console.error('Airtable update error:', err.message));
}

// ── Route: auth ──────────────────────────────────────────────────────────────
function handleAuth(req, res) {
  const { email } = req.query ?? {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required as query param' });
  }
  const state = signState(email.toLowerCase().trim());
  const params = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    response_type: 'code', scope: SCOPES, state, prompt: 'consent',
  });
  res.redirect(302, `${DISCORD_OAUTH}?${params}`);
}

// ── Route: callback ──────────────────────────────────────────────────────────
async function handleCallback(req, res) {
  const { code, state, error: oauthErr } = req.query ?? {};
  if (oauthErr) return res.redirect(302, `${DOMAIN}/discord-welcome.html?error=denied`);
  if (!code || !state) return res.status(400).json({ error: 'Missing code or state' });

  let email;
  try { email = verifyState(state); } catch (e) {
    return res.status(403).json({ error: 'Invalid state', detail: e.message });
  }

  let token, user;
  try { token = await exchangeCode(code); user = await getUser(token.access_token); } catch (e) {
    return res.status(502).json({ error: 'Discord auth failed', detail: e.message });
  }

  let nft;
  try { nft = await lookupNft(email); } catch (e) {
    return res.status(502).json({ error: 'NFT lookup failed', detail: e.message });
  }
  if (!nft) return res.redirect(302, `${DOMAIN}/discord-welcome.html?error=no_nft`);

  const roleId = NFT_ROLE_MAP[nft.nftType];
  if (!roleId) return res.status(500).json({ error: `No role for NFT type: ${nft.nftType}` });

  try { await addMemberToGuild(user.id, token.access_token, [roleId]); } catch (e) {
    console.warn('addMember warning:', e.message);
  }
  try { await assignRole(user.id, roleId); } catch (e) {
    return res.status(502).json({ error: 'Role assignment failed', detail: e.message });
  }

  updateAirtableRecord(nft.recordId, user.id).catch(() => {});
  res.redirect(302, `${DOMAIN}/discord-welcome.html?role=${encodeURIComponent(nft.nftType)}&server=${GUILD_ID}`);
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.aurevonvc.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query?.action ?? '';

  switch (action) {
    case 'auth':     return handleAuth(req, res);
    case 'callback': return handleCallback(req, res);
    default:
      return res.status(400).json({
        error: 'Missing or invalid action param',
        valid: ['auth', 'callback'],
      });
  }
}
