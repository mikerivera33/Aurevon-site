/**
 * Unified Discord handler — /api/discord?action=auth|callback|sync
 *
 * action=auth&token=xxx     → verify email-ownership token, redirect to Discord OAuth
 * action=callback&code=x    → handle OAuth callback, assign role, write Airtable
 * action=sync  (POST)       → bot-assign role for a member who already has a Discord ID
 *                             Body: { email, secret? }  OR use CRON_SECRET header
 *
 * Function limit note: all Discord actions consolidated here to stay under
 * the Vercel Hobby 12-function limit.
 */

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { addRoleToMember, addMemberToGuild } from './_lib/discord-bot.js';
import { upsertDiscordLink, updateDiscordSyncStatus, findActiveMintByEmail, findMemberByEmail, isDiscordAuthNonceUsed } from './_lib/airtable.js';
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

// ── Timing-safe secret compare ───────────────────────────────────────────────
// Length-guarded crypto.timingSafeEqual for variable-length secrets, matching
// the pattern in api/member/claim.js and api/email/send.js. Returns true only
// on an exact match. Callers MUST still guard against an unset/empty configured
// secret BEFORE calling this — two empty strings compare equal here.
export function timingSafeStrEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  try {
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

// ── Email-ownership access tokens (H2 fix) ───────────────────────────────────
// The OAuth flow must not trust a bare ?email= — that granted the paid role to
// ANYONE who knew a member's address (HMAC = integrity, NOT authorization). Instead
// we require a SIGNED, email-bound, EXPIRING, single-use token that is only ever
// delivered to the member's inbox (mint-success + claim-request emails). Possessing
// a valid token IS the proof of inbox ownership, and the email is derived FROM the
// token — never from a separate query param.
//
// Token = base64url(JSON{e:email, x:expiryMs, n:nonce}) + "." + base64url(HMAC).
// The MAC is computed over the exact serialized payload bytes so the delimiter can
// never collide with email contents. Verified timing-safe. Single-use is enforced
// at the callback (the point of the actual role grant) via an Airtable-stored
// consumed-nonce — see api/_lib/airtable.js.
//
// TTL: 7 days. Product decision — a mint-delivery email may sit unread for days;
// 7d keeps the marketed "click the link in your email" flow working while bounding
// replay exposure. Re-requesting a fresh link via /member-claim.html is one click.
const ACCESS_TOKEN_TTL_MS = Number(process.env.DISCORD_ACCESS_TOKEN_TTL_MS) || 7 * 24 * 60 * 60 * 1000;

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecodeToString(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/**
 * Mint a signed, email-bound, expiring, single-use access token. Throws if
 * STATE_SECRET is not configured (fail closed — never issue an unsigned token).
 */
export function signDiscordAccessToken(email) {
  const secret = process.env.STATE_SECRET;
  if (!secret) throw new Error('STATE_SECRET not configured');
  const normalized = String(email).toLowerCase().trim();
  const payloadB64 = b64url(JSON.stringify({ e: normalized, x: Date.now() + ACCESS_TOKEN_TTL_MS, n: randomBytes(12).toString('hex') }));
  const mac = b64url(createHmac('sha256', secret).update(payloadB64).digest());
  return `${payloadB64}.${mac}`;
}

/**
 * Verify an access token: timing-safe signature check + expiry. Returns
 * { email, nonce, exp } derived FROM the token. Throws on any failure.
 */
export function verifyDiscordAccessToken(token) {
  const secret = process.env.STATE_SECRET;
  if (!secret) throw new Error('STATE_SECRET not configured');
  if (typeof token !== 'string') throw new Error('Missing token');
  const lastDot = token.lastIndexOf('.');
  if (lastDot <= 0) throw new Error('Malformed token');
  const payloadB64 = token.slice(0, lastDot);
  const macB64 = token.slice(lastDot + 1);
  const expectedMac = b64url(createHmac('sha256', secret).update(payloadB64).digest());
  const a = Buffer.from(macB64);
  const b = Buffer.from(expectedMac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Signature mismatch');
  let payload;
  try { payload = JSON.parse(b64urlDecodeToString(payloadB64)); }
  catch { throw new Error('Malformed payload'); }
  if (!payload || typeof payload.e !== 'string' || typeof payload.x !== 'number' || typeof payload.n !== 'string') {
    throw new Error('Invalid payload');
  }
  if (Date.now() > payload.x) throw new Error('Token expired');
  return { email: payload.e, nonce: payload.n, exp: payload.x };
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
  // AuthZ: require a signed email-ownership token. We DO NOT accept a bare
  // ?email= (that was the H2 hole). OLD ?email=-only links already sent to
  // customers FAIL CLOSED here — they must re-request a fresh link from the
  // member-claim page (documented UX tradeoff; do not reopen the hole for compat).
  const { token } = req.query ?? {};
  if (!token) {
    return res.status(400).json({
      error: 'A valid access link is required. Request a fresh one from the member portal.',
      requestLink: `${DOMAIN}/member-claim.html`,
    });
  }
  try { verifyDiscordAccessToken(token); }
  catch {
    return res.status(403).json({
      error: 'This access link is invalid or has expired. Request a fresh one from the member portal.',
      requestLink: `${DOMAIN}/member-claim.html`,
    });
  }
  // The token is already email-bound, signed and expiring — reuse it verbatim as
  // the OAuth `state` so the callback re-derives the email from it (never a param).
  const params = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    response_type: 'code', scope: SCOPES, state: token, prompt: 'consent',
  });
  res.redirect(302, `${DISCORD_OAUTH}?${params}`);
}

// ── Route: callback ──────────────────────────────────────────────────────────

async function handleCallback(req, res) {
  const { code, state, error: oauthErr } = req.query ?? {};
  if (oauthErr) return res.redirect(302, `${DOMAIN}/discord-welcome.html?error=denied`);
  if (!code || !state) return res.status(400).json({ error: 'Missing code or state' });

  // `state` is the same signed access token issued at auth-time. Re-verify it
  // (signature + expiry, timing-safe) and derive the email + single-use nonce
  // from it — never trust a separate param.
  let email, nonce;
  try { ({ email, nonce } = verifyDiscordAccessToken(state)); }
  catch { return res.redirect(302, `${DOMAIN}/discord-welcome.html?error=invalid_link`); }

  // Single-use (defense-in-depth vs. a leaked/forwarded link being replayed after
  // it was already redeemed). Enforced HERE — at the actual role grant — not at
  // auth, so an aborted OAuth doesn't waste the token. Fails OPEN on lookup error:
  // the signature already authorizes, and blocking on Airtable downtime would deny
  // legitimate first-time linking. Limitation: only the most-recently-consumed
  // nonce is stored, so redeeming a newer token does not retroactively invalidate
  // an older still-valid one — but every such token was inbox-delivered, so that
  // only ever benefits someone who already controls the inbox (already authorized).
  try {
    if (await isDiscordAuthNonceUsed(email, nonce)) {
      return res.redirect(302, `${DOMAIN}/discord-welcome.html?error=link_used`);
    }
  } catch (e) {
    console.error(`[Discord] single-use nonce check failed (continuing): ${e.message}`);
  }

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

  // Persist Discord link to Airtable + burn the single-use nonce (records this
  // token as consumed so a replay of the same link is rejected above).
  try {
    await upsertDiscordLink(email, { discordId: user.id, discordUsername: user.username, authNonce: nonce });
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

  // Fail CLOSED: if no secret is configured, reject rather than allow
  // unauthenticated role assignment (handleCheckMembership already fails closed;
  // this previously failed OPEN when neither SYNC_SECRET nor CRON_SECRET was set).
  if (!SYNC_SECRET || !timingSafeStrEqual(providedSecret, SYNC_SECRET)) {
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
  // Header-only (L2): never accept the secret via ?secret= — query strings are
  // captured in Vercel/CDN access logs. Vercel cron sends the Bearer header.
  const auth = req.headers?.authorization ?? '';
  if (!timingSafeStrEqual(auth, `Bearer ${secret}`)) {
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
