/**
 * Health check endpoint — GET /api/health
 *
 * Public: a minimal liveness body { ok, status, database } (always 200).
 * Authed (Bearer INTERNAL_API_SECRET): the full readiness report from
 * _lib/health-checks.js — env names, Stripe webhook events, Crossmint, Discord,
 * cron heartbeats, queue counts — HTTP 503 when the money path is not ready.
 * Never reveals values — only names, presence and states.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbConfigured, ping } from './_lib/db.js';
import { envReport, runHealthChecks, readinessProblems, _resetHealthChecksCache } from './_lib/health-checks.js';

const VERSION = '2.3.0';

// Vercel Pro: 100 serverless functions per project (Hobby is 12).
const FUNCTION_LIMIT = 100;

// Count actual deployable functions on disk so the report doesn't drift as
// files are added/removed. Same exclusions as .vercelignore + the _lib/_archived/
// helper-only paths that Vercel never wraps as functions.
const FUNCTION_COUNT = (() => {
  const apiDir = path.dirname(fileURLToPath(import.meta.url));
  const EXCLUDE_DIRS = new Set(['_lib', '_archived', 'test', 'cron', 'lib']);
  function countJs(dir) {
    let n = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) continue;
        n += countJs(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        n += 1;
      }
    }
    return n;
  }
  try { return countJs(apiDir); } catch { return 0; }
})();

const REQUIRED_ENV = [
      // Stripe
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      // PayPal (IPN only — the REST client id/secret are not read)
      'PAYPAL_BUSINESS_EMAIL',
      // Crossmint (core — required for any NFT mint)
      'CROSSMINT_API_KEY',
      'CROSSMINT_COLLECTION_ID',
      // Required: webhook signature verification is mandatory (fail-closed);
      // without it /api/webhooks/crossmint returns 500 and mints never sync roles.
      'CROSSMINT_WEBHOOK_SECRET',
      // Resend
      'RESEND_API_KEY',
      'RESEND_FROM_EMAIL',
      // Supabase (data layer). SUPABASE_SERVICE_ROLE_KEY is accepted for the key.
      'SUPABASE_URL',
      'SUPABASE_SECRET_KEY',
      // Owner consoles (/api/admin/data)
      'ADMIN_SECRET',
      // Alerts: the pipeline's failures go nowhere without it
      'ALERT_WEBHOOK_URL',
      // Discord
      'DISCORD_BOT_TOKEN',
      'DISCORD_CLIENT_ID',
      'DISCORD_CLIENT_SECRET',
      'DISCORD_GUILD_ID',
      'DISCORD_INVITE_URL',
      // Entitlement roles
      'DISCORD_ROLE_MONTHLY',
      'DISCORD_ROLE_LIFETIME',
      'DISCORD_ROLE_PRODUCT_A',
      'DISCORD_ROLE_PRODUCT_B',
      'DISCORD_ROLE_PRODUCT_C',
      // Security
      'STATE_SECRET',
      'SYNC_SECRET',
      'RECONCILE_SECRET',
      // Gates the direct mint endpoint (/api/crossmint/mint → claim.js?action=mint).
      // Missing ⇒ that endpoint returns 500 and the Zapier/Make automation can't mint.
      'INTERNAL_API_SECRET',
      // Required for Vercel cron auth: Vercel only attaches the
      // `Authorization: Bearer <CRON_SECRET>` header when this is set. Without
      // it the retry-mints / reconcile crons silently 401 and never run.
      'CRON_SECRET',
    ];

const OPTIONAL_ENV = [
      // Crossmint optional — per-entitlement collection IDs (new entitlement system)
      'CROSSMINT_COLLECTION_MONTHLY',
      'CROSSMINT_COLLECTION_LIFETIME',
      'CROSSMINT_COLLECTION_PRODUCT_A',
      'CROSSMINT_COLLECTION_PRODUCT_B',
      'CROSSMINT_COLLECTION_PRODUCT_C',
      // Crossmint optional
      'CROSSMINT_PROJECT_ID',
      'CROSSMINT_CHAIN',
      // Other optional integrations
      'ENGAGE_IO_API_KEY',
      'ENGAGE_IO_WORKSPACE_ID',
      'COLLABLAND_COMMUNITY_ID',
      'ENTITLEMENT_GRACE_PERIOD_DAYS',
      'PAYPAL_SANDBOX',
      'PAYPAL_ITEM_TIERS',
      // Owner email sink for high/critical alerts (with RESEND_API_KEY + RESEND_FROM_EMAIL)
      'OWNER_ALERT_EMAIL',
      'RESEND_FROM_NAME',
      'DISCORD_ROLE_VERIFIED',
      // Temporary Airtable → Supabase bridge (remove once the import reports nothing new)
      'AIRTABLE_PAT',
      'AIRTABLE_BASE_ID',
    ];

// One database ping per warm instance every 30s, however often /api/health is hit.
const DB_STATUS_TTL_MS = 30_000;
let dbStatusCache = null; // { value, at }

/** 'ok' | 'unconfigured' | 'unavailable' — answers within ~3s. */
async function databaseStatus() {
  if (!dbConfigured()) return 'unconfigured';
  if (dbStatusCache && Date.now() - dbStatusCache.at < DB_STATUS_TTL_MS) return dbStatusCache.value;
  let value;
  try {
    await Promise.race([ping(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
    value = 'ok';
  } catch (err) {
    console.error(`[health] database check failed: ${err.message}`);
    value = 'unavailable';
  }
  dbStatusCache = { value, at: Date.now() };
  return value;
}

/** Test hook. */
export function _resetHealthCache() { dbStatusCache = null; _resetHealthChecksCache(); }

export default async function handler(req, res) {
      if (req.method !== 'GET') {
              return res.status(405).json({ error: 'Method not allowed' });
      }

  // Info-disclosure hardening (L1): the full diagnostic body below is a precise
  // misconfiguration map (env completeness, the exact names of any missing
  // required vars, version). Public/unauthenticated callers get a minimal
  // liveness body only. The diagnostic is gated behind a bearer secret
  // (INTERNAL_API_SECRET — already used by the internal mint automation), compared
  // timing-safely with a length guard. Fail CLOSED: a health endpoint must always
  // answer and never leak, so when the secret is unset nobody can authenticate and
  // no caller ever receives diagnostics.
  const secret = process.env.INTERNAL_API_SECRET;
  const rawAuth = req.headers?.authorization ?? '';
  const provided = rawAuth.startsWith('Bearer ') ? rawAuth.slice(7) : '';
  // Compare on BYTE length (not JS string length) and wrap timingSafeEqual in
  // try/catch — it throws RangeError on a byte-length mismatch, which a
  // string-length guard does not prevent (multi-byte chars). Fails CLOSED to the
  // minimal body on any mismatch/error. Matches the pattern in discord.js/claim.js.
  let authed = false;
  if (secret) {
        const bufProvided = Buffer.from(provided);
        const bufSecret = Buffer.from(secret);
        if (bufProvided.length === bufSecret.length) {
              try { authed = crypto.timingSafeEqual(bufProvided, bufSecret); } catch { authed = false; }
        }
  }

  const database = await databaseStatus();

  if (!authed) {
        return res.status(200).json({ ok: true, status: 'healthy', database });
  }

  // Authed diagnostic: names and states only, never values. Not ready ⇒ 503
  // (authed callers only — the public body above never reveals readiness).
  const env = envReport(REQUIRED_ENV);
  const checks = await runHealthChecks();
  const problems = readinessProblems({ database, env, checks });
  const ok = problems.length === 0;
  const optionalPresent = OPTIONAL_ENV.filter((k) => Boolean(process.env[k])).length;
  const ownerEmail = Boolean(process.env.OWNER_ALERT_EMAIL && process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL);

  return res.status(ok ? 200 : 503).json({
          ok,
          status: ok ? 'healthy' : 'degraded',
          problems,
          version: VERSION,
          timestamp: new Date().toISOString(),
          pipeline: 'Aurevon NFT Membership + Discord Automation',
          database,
          env,
          optional_env: `${optionalPresent}/${OPTIONAL_ENV.length}`,
          mint: checks.mint,
          stripe: checks.stripe,
          email: { resend_configured: Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL) },
          discord: checks.discord,
          crons: checks.crons,
          queue: checks.queue,
          alerts: { webhook_configured: Boolean(process.env.ALERT_WEBHOOK_URL), owner_email_configured: ownerEmail },
          function_count: FUNCTION_COUNT,
          function_limit: FUNCTION_LIMIT,
  });
}
