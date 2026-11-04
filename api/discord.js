/**
 * Unified Discord handler — /api/discord?action=auth|callback|sync
 *
 * action=auth&token=xxx     → verify email-ownership token, redirect to Discord OAuth
 * action=callback&code=x    → handle OAuth callback, assign every grantable role, save the Discord link
 * action=sync  (POST)       → bot-assign every grantable role for a member who already has a Discord ID
 *                             Body: { email, secret? }  OR use CRON_SECRET header
 *
 * auth / callback are browser routes: every failure is a 302 to
 * /discord-welcome.html?error=<code>. sync / check-membership are APIs (JSON).
 *
 * Function limit note: all Discord actions consolidated here to stay under
 * the Vercel Hobby 12-function limit.
 */

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { addRoleToMember, addMemberToGuild, syncMemberRoles } from './_lib/discord-bot.js';
import { upsertDiscordLink, updateDiscordSyncStatus, findActiveMintsByEmail, findMemberByEmail, isDiscordAuthNonceUsed, markDiscordAuthNonceUsed, dbConfigured } from './_lib/db.js';
import {
  ENTITLEMENT_MAP, resolveEntitlementFromNftType,
  grantableEntitlements, grantableRoleIds, obsoleteRoleIds, alertMissingRoles, UNKNOWN_BILLING_FIELDS,
} from './_lib/entitlements.js';
import { sendAlert } from './_lib/alert.js';
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
// at the callback (the point of the actual role grant) via a stored
// consumed-nonce — see markDiscordAuthNonceUsed in api/_lib/db.js.
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

// ── Browser-facing failures ──────────────────────────────────────────────────
// auth / callback are opened from an emailed link, so every failure lands on
// discord-welcome.html with a code the page turns into copy + a "new link"
// button — never a raw JSON body. The API routes (sync, check-membership) keep JSON.
const WELCOME_ERRORS = new Set(['invalid_link', 'link_used', 'no_nft', 'auth_failed', 'role_failed', 'denied']);

function redirectError(res, code) {
  const c = WELCOME_ERRORS.has(code) ? code : 'auth_failed';
  return res.redirect(302, `${DOMAIN}/discord-welcome.html?error=${c}`);
}

/** HTTP status from a discord-bot error message, for alerts (no body / ids). */
function discordStatus(err) {
  const msg = String(err?.message ?? '');
  if (/not found in guild/.test(msg)) return 404;
  const m = msg.match(/\((\d{3})\)/);
  return m ? Number(m[1]) : 'error';
}

// ── Route: auth ──────────────────────────────────────────────────────────────

function handleAuth(req, res) {
  // AuthZ: require a signed email-ownership token. We DO NOT accept a bare
  // ?email= (that was the H2 hole). OLD ?email=-only links already sent to
  // customers FAIL CLOSED here — they must re-request a fresh link from
  // /member-claim (documented UX tradeoff; do not reopen the hole for compat).
  const { token } = req.query ?? {};
  if (!token) return redirectError(res, 'invalid_link');
  try { verifyDiscordAccessToken(token); }
  catch { return redirectError(res, 'invalid_link'); }
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
  if (oauthErr) return redirectError(res, 'denied');
  if (!code || !state) return redirectError(res, 'invalid_link');

  // `state` is the same signed access token issued at auth-time. Re-verify it
  // (signature + expiry, timing-safe) and derive the email + single-use nonce
  // from it — never trust a separate param.
  let email, nonce;
  try { ({ email, nonce } = verifyDiscordAccessToken(state)); }
  catch { return redirectError(res, 'invalid_link'); }

  // Single-use (defense-in-depth vs. a leaked/forwarded link being replayed after
  // it was already redeemed). Enforced HERE — at the actual role grant — not at
  // auth, so an aborted OAuth doesn't waste the token. Fails OPEN on lookup error:
  // the signature already authorizes, and blocking on database downtime would deny
  // legitimate first-time linking. Limitation: only the most-recently-consumed
  // nonce is stored, so redeeming a newer token does not retroactively invalidate
  // an older still-valid one — but every such token was inbox-delivered, so that
  // only ever benefits someone who already controls the inbox (already authorized).
  try {
    if (await isDiscordAuthNonceUsed(email, nonce)) return redirectError(res, 'link_used');
  } catch (e) {
    console.error(`[Discord] single-use nonce check failed (continuing): ${e.message}`);
  }

  let token, user;
  try { token = await exchangeCode(code); user = await getDiscordUser(token.access_token); }
  catch (e) {
    console.error(`[Discord] OAuth exchange failed: ${e.message}`);
    return redirectError(res, 'auth_failed');
  }

  // Find this member's active NFT mints. A failed lookup is our fault, not a
  // missing membership — say "couldn't link", not "no membership".
  let mints;
  try { mints = await findActiveMintsByEmail(email); }
  catch (e) {
    console.error(`[Discord] mint lookup failed: ${e.message}`);
    return redirectError(res, 'auth_failed');
  }

  // Recurring monthly: the Genesis mint stays Minted/Sent after cancel, so an
  // inbox-owned claim link would re-grant the role forever unless we re-check
  // billing here — the same shouldRevokeAccess window the daily cron uses.
  // Every pass still grantable gets its role, so a lapsed Genesis never hides
  // a permanent one. A failed member lookup fails closed for monthly only.
  let memberFields;
  try { memberFields = (await findMemberByEmail(email))?.fields; }
  catch (e) {
    console.error(`[Discord] billing lookup failed (fail-closed for revocable): ${e.message}`);
    memberFields = UNKNOWN_BILLING_FIELDS;
  }
  const keys = grantableEntitlements(mints ?? [], memberFields);
  if (!keys.length) {
    console.warn('[Discord] no grantable pass for this link');
    return redirectError(res, 'no_nft');
  }
  // A paying member whose role env is unset is our config fault, not a missing
  // membership: alert, show "couldn't link", and leave the link unburned.
  const { roleIds, missing } = grantableRoleIds(mints, memberFields);
  await alertMissingRoles(missing);
  if (!roleIds.length) return redirectError(res, 'role_failed');

  // Join the guild with every role (no-op for members already in it), then add
  // each role explicitly — idempotent, and covers members who were already in.
  try { await addMemberToGuild(user.id, token.access_token, roleIds); }
  catch (e) { console.warn(`[Discord] addMemberToGuild warning: ${e.message}`); }

  const failed = [];
  for (const roleId of roleIds) {
    try { await addRoleToMember(user.id, roleId); }
    catch (e) { failed.push(e); }
  }
  if (failed.length) {
    const all = failed.length === roleIds.length;
    console.error(`[Discord] role grant failed for ${failed.length}/${roleIds.length} role(s): ${failed[0].message}`);
    await sendAlert('discord.role_grant_failed', { status: discordStatus(failed[0]), count: failed.length },
      // Any missing paid role is critical (partial or total).
      { severity: 'critical' });
    if (all) return redirectError(res, 'role_failed');
  }

  // Persist the Discord link. A partial grant (failed add or unconfigured role)
  // stays 'pending' so the reconcile cron grants the rest.
  try {
    await upsertDiscordLink(email, { discordId: user.id, discordUsername: user.username });
    await updateDiscordSyncStatus(email, failed.length || missing.length ? 'pending' : 'synced');
  } catch (e) {
    console.error(`[Discord] member update failed: ${e.message}`);
  }

  // Burn the single-use nonce as a SEPARATE best-effort write (records this token
  // as consumed so a replay of the same link is rejected above). Isolated so that
  // a missing "Discord Auth Nonce Used" field cannot 422 the whole link-persist.
  try {
    await markDiscordAuthNonceUsed(email, nonce);
  } catch (e) {
    console.error(`[Discord] single-use nonce write failed (link still persisted): ${e.message}`);
  }

  // Fire Engage events (non-fatal), one per pass granted.
  const grantedKeys = keys.filter((k) => !missing.includes(k));
  const nftTypes = grantedKeys.map((k) => ENTITLEMENT_MAP[k].nftType);
  for (const key of grantedKeys) {
    const mint = (mints ?? []).find((m) => resolveEntitlementFromNftType(m?.fields?.['NFT Type'] ?? '') === key);
    onEntitlementActivated({
      email,
      entitlementType: key,
      nftType: ENTITLEMENT_MAP[key].nftType,
      serial: mint?.fields?.['Reference'] ?? '',
    }).catch(() => {});
  }

  const welcome = new URLSearchParams({ role: nftTypes.join(', ') });
  if (GUILD_ID) welcome.set('server', GUILD_ID);
  res.redirect(302, `${DOMAIN}/discord-welcome.html?${welcome}`);
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
  catch (e) { return res.status(502).json({ error: 'Member lookup failed', detail: e.message }); }

  if (!member) return res.status(404).json({ error: 'Member not found' });

  const discordId = member.fields['Discord ID'];
  if (!discordId) return res.status(422).json({ error: 'Member has no linked Discord ID — they must complete OAuth first', link: `${DOMAIN}/member-claim` });

  // Look up active mints; grant every pass billing still allows
  let mints;
  try { mints = await findActiveMintsByEmail(email); }
  catch (e) { return res.status(502).json({ error: 'NFT lookup failed', detail: e.message }); }

  if (!mints.length) return res.status(404).json({ error: 'No active NFT mint found for this email' });
  const entitlementKeys = grantableEntitlements(mints, member.fields);
  if (!entitlementKeys.length) return res.status(403).json({ error: 'Membership is no longer active' });

  const { roleIds, missing } = grantableRoleIds(mints, member.fields);
  await alertMissingRoles(missing);
  if (!roleIds.length) {
    return res.status(500).json({ error: `No Discord role configured for entitlement: ${missing.join(',')}` });
  }

  try {
    await syncMemberRoles(discordId, roleIds, obsoleteRoleIds(mints, member.fields));
    await updateDiscordSyncStatus(email, missing.length ? 'pending' : 'synced');
    return res.status(200).json({ ok: true, discordId, roleIds, entitlementKeys, ...(missing.length ? { missing } : {}) });
  } catch (e) {
    const partial = (e.granted?.length ?? 0) > 0;
    await updateDiscordSyncStatus(email, partial ? 'pending' : 'failed', { error: e.message }).catch(() => {});
    return res.status(502).json({ error: 'Role assignment failed', detail: e.message, roleIds, failedRoleIds: e.failedRoleIds ?? roleIds });
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

  if (!dbConfigured()) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'Database not configured', synced: 0, errors: 0 });
  }

  const { listPendingDiscordSync, findActiveMintsByEmail: findMints, updateDiscordSyncStatus: updateSync } = await import('./_lib/db.js');
  const synced = [];
  const errors = [];

  try {
    const pending = await listPendingDiscordSync({ maxRecords: 100 });
    for (const member of pending) {
      const email     = member.fields?.['Email'] ?? '';
      const discordId = member.fields?.['Discord ID'];
      if (!email || !discordId) continue;
      try {
        const mints = await findMints(email);
        if (!mints.length) continue;
        // Same billing gate as the OAuth callback: a cancelled / lapsed monthly
        // member still has a Minted Genesis row, so the mint alone isn't proof.
        const entitlementKeys = grantableEntitlements(mints, member.fields);
        if (!entitlementKeys.length) {
          await updateSync(email, 'revoked');
          continue;
        }
        const { roleIds, missing } = grantableRoleIds(mints, member.fields);
        await alertMissingRoles(missing);
        if (!roleIds.length) continue; // stays 'pending' until the role env is set
        await syncMemberRoles(discordId, roleIds, obsoleteRoleIds(mints, member.fields));
        await updateSync(email, missing.length ? 'pending' : 'synced');
        synced.push({ email, discordId, roleIds, entitlementKeys });
      } catch (err) {
        errors.push({ email, error: err.message });
        // A partial grant stays 'pending' so the next run adds the rest.
        const partial = (err.granted?.length ?? 0) > 0;
        await updateSync(email, partial ? 'pending' : 'failed', { error: err.message }).catch(() => {});
      }
    }
  } catch (err) {
    return res.status(500).json({ error: 'Membership check failed', detail: err.message });
  }

  return res.status(200).json({ ok: true, synced: synced.length, errors: errors.length, details: { synced, errors } });
}
