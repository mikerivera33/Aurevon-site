/**
 * Unified Discord handler — /api/discord?action=auth|callback|sync
 *
 * action=auth&email=xxx     → redirect to Discord OAuth consent screen
 * action=callback&code=x    → handle OAuth callback, assign role, write Airtable
 * action=sync  (POST)       → bot-assign role for a member who already has a Discord ID
 *                             Body: { email, secret? }  OR use CRON_SECRET header
 *
 * Function limit note: all Discord actions consolidated here to stay under
 * the Vercel Hobby 12-function limit.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { addRoleToMember, addMemberToGuild } from './_lib/discord-bot.js';
import { upsertDiscordLink, updateDiscordSyncStatus, findActiveMintByEmail, findMemberByEmail } from './_lib/airtable.js';
import { resolveEntitlementFromNftType, getRoleId } from './_lib/entitlements.js';
import { onEntitlementActivated } from './_lib/engage.js';

// ── Env ──────────────────────────────────────────────────────────────────────
const CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const GUILD_ID      = process.env.DISCORD_GUILD_ID;
const DOMAIN        = process.env.DOMAIN ?? 'https://www.aurevonvc.com';
const STATE_SECRET  = process.env.STATE_SECRET;
if (!STATE_SECRET) {
  console.error('[Discord OAuth] STATE_SECRET env var is required but not set');
  // Will throw naturally when signState/verifyState are called
}
const SYNC_SECRET   = process.env.SYNC_SECRET  ?? process.env.CRON_SECRET ?? '';

const REDIRECT_URI  = `${DOMAIN}/api/discord?action=callback`;
const DISCORD_API   = 'https://discord.com/api/v10';
const DISCORD_OAUTH = 'https://discord.com/api/oauth2/authorize';
const SCOPES        = 'identify guilds.join';

// ── HMAC state helpers ───────────────────────────────────────────────────────

function signState(email) {
  const mac = createHmac('sha256', STATE_SECRET).update(email).digest('hex').slice(0, 32);
  return `${email}.${mac}`;
}

function verifyState(state) {
  const lastDot = state.lastIndexOf('.');
  if (lastDot === -1) throw new Error('Invalid state format');
  const email = state.slice(0, lastDot);
  const received = state.slice(lastDot + 1);
  const expected = createHmac('sha256', STATE_SECRET).update(email).digest('hex').slice(0, 32);
  const a = Buffer.from(received.padEnd(32, '0'));
  const b = Buffer.from(expected.padEnd(32, '0'));
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('State HMAC mismatch');
  return email;
}

// ── Discord OAuth helpers ────────────────────────────────────────────────────

async function discordFetchError(res, ctx) {
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
  if (!res.ok) await discordFetchError(res, 'token exchange');
  return res.json();
}

async function getDiscordUser(accessToken) {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) await discordFetchError(res, 'get user');
  return res.json();
}

// ── Route: auth ──────────────────────────────────────────────────────────────

function handleAuth(req, res) {
  const { email } = req.query ?? {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required as ?email= query param' });
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
  try { email = verifyState(state); }
  catch (e) { return res.status(403).json({ error: 'Invalid state', detail: e.message }); }

  let token, user;
  try { token = await exchangeCode(code); user = await getDiscordUser(token.access_token); }
  catch (e) { return res.status(502).json({ error: 'Discord auth failed', detail: e.message }); }

  // Find this member's active NFT mint in Airtable
  let mintRecord = null;
  try { mintRecord = await findActiveMintByEmail(email); }
  catch (e) { console.error(`[Discord] Airtable lookup failed: ${e.message}`); }

  if (!mintRecord) {
    return res.redirect(302, `${DOMAIN}/discord-welcome.html?error=no_nft`);
  }

  const nftType = mintRecord.fields['NFT Type'] ?? '';
  const entitlementKey = resolveEntitlementFromNftType(nftType);
  const roleId = entitlementKey ? getRoleId(entitlementKey) : null;

  if (!roleId) {
    console.error(`[Discord] No roleId for nftType="${nftType}" entitlement="${entitlementKey}"`);
    return res.status(500).json({ error: `No Discord role configured for NFT type: ${nftType}` });
  }

  // Add member to guild (OAuth flow)
  try { await addMemberToGuild(user.id, token.access_token, [roleId]); }
  catch (e) { console.warn(`[Discord] addMemberToGuild warning: ${e.message}`); }

  // Assign role via bot
  try { await addRoleToMember(user.id, roleId); }
  catch (e) {
    return res.status(502).json({ error: 'Role assignment failed', detail: e.message });
  }

  // Persist Discord link to Airtable
  try {
    await upsertDiscordLink(email, { discordId: user.id, discordUsername: user.username });
    await updateDiscordSyncStatus(email, 'synced');
  } catch (e) {
    console.error(`[Discord] Airtable update failed: ${e.message}`);
  }

  // Fire Engage event (non-fatal)
  onEntitlementActivated({
    email,
    entitlementType: entitlementKey ?? '',
    nftType,
    serial: mintRecord.fields['Reference'] ?? '',
  }).catch(() => {});

  res.redirect(302, `${DOMAIN}/discord-welcome.html?role=${encodeURIComponent(nftType)}&server=${GUILD_ID}`);
}

// ── Route: sync (bot-initiated, no OAuth) ────────────────────────────────────

async function handleSync(req, res) {
  // Validate sync secret — accept via body or Authorization header
  const authHeader = req.headers['authorization'] ?? '';
  const bodySecret = req.body?.secret ?? '';
  const providedSecret = authHeader.replace('Bearer ', '').trim() || bodySecret;

  if (SYNC_SECRET && providedSecret !== SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const email = req.body?.email;
  if (!email) return res.status(400).json({ error: 'Missing email in request body' });

  // Look up member record
  let member;
  try { member = await findMemberByEmail(email); }
  catch (e) { return res.status(502).json({ error: 'Airtable lookup failed', detail: e.message }); }

  if (!member) return res.status(404).json({ error: 'Member not found in Airtable' });

  const discordId = member.fields['Discord ID'];
  if (!discordId) return res.status(422).json({ error: 'Member has no linked Discord ID — they must complete OAuth first', link: `${DOMAIN}/member-claim.html` });

  // Look up active mint
  let mintRecord;
  try { mintRecord = await findActiveMintByEmail(email); }
  catch (e) { return res.status(502).json({ error: 'NFT lookup failed', detail: e.message }); }

  if (!mintRecord) return res.status(404).json({ error: 'No active NFT mint found for this email' });

  const nftType = mintRecord.fields['NFT Type'] ?? '';
  const entitlementKey = resolveEntitlementFromNftType(nftType);
  const roleId = entitlementKey ? getRoleId(entitlementKey) : null;

  if (!roleId) {
    return res.status(500).json({ error: `No Discord role configured for entitlement: ${entitlementKey}` });
  }

  try {
    await addRoleToMember(discordId, roleId);
    await updateDiscordSyncStatus(email, 'synced');
    return res.status(200).json({ ok: true, discordId, roleId, nftType, entitlementKey });
  } catch (e) {
    await updateDiscordSyncStatus(email, 'failed', { error: e.message }).catch(() => {});
    return res.status(502).json({ error: 'Role assignment failed', detail: e.message });
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', DOMAIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query?.action ?? '';

  switch (action) {
    case 'auth':              return handleAuth(req, res);
    case 'callback':          return handleCallback(req, res);
    case 'sync':              return handleSync(req, res);
    case 'check-membership':  return handleCheckMembership(req, res);
    default:
      return res.status(400).json({
        error: 'Missing or invalid action param',
        valid: ['auth', 'callback', 'sync', 'check-membership'],
      });
  }
}

// ── Cron: check membership sync ───────────────────────────────────────────────

async function handleCheckMembership(req, res) {
  const secret = SYNC_SECRET;
  if (!secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const auth  = req.headers?.authorization ?? '';
  const query = req.query?.secret ?? '';
  if (auth !== `Bearer ${secret}` && query !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!process.env.AIRTABLE_PAT || !process.env.AIRTABLE_BASE_ID) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'Airtable not configured', synced: 0, errors: 0 });
  }

  const { listPendingDiscordSync, findActiveMintByEmail: findMint, updateDiscordSyncStatus: updateSync } = await import('./_lib/airtable.js');
  const synced = [];
  const errors = [];

  try {
    const pending = await listPendingDiscordSync({ maxRecords: 100 });
    for (const member of pending) {
      const email     = member.fields?.['Email'] ?? '';
      const discordId = member.fields?.['Discord ID'];
      if (!email || !discordId) continue;
      try {
        const mint = await findMint(email);
        if (!mint) continue;
        const nftType        = mint.fields['NFT Type'] ?? '';
        const entitlementKey = resolveEntitlementFromNftType(nftType);
        const roleId         = entitlementKey ? getRoleId(entitlementKey) : null;
        if (!roleId) continue;
        await addRoleToMember(discordId, roleId);
        await updateSync(email, 'synced');
        synced.push({ email, discordId, nftType });
      } catch (err) {
        errors.push({ email, error: err.message });
        await updateSync(email, 'failed', { error: err.message }).catch(() => {});
      }
    }
  } catch (err) {
    return res.status(500).json({ error: 'Membership check failed', detail: err.message });
  }

  return res.status(200).json({ ok: true, synced: synced.length, errors: errors.length, details: { synced, errors } });
}
