/**
 * Authed /api/health probes: prove the money path is actually wired.
 *
 * Every probe answers within PROBE_TIMEOUT_MS, runs under Promise.allSettled
 * (one failing probe never hides the others), and reports NAMES and states only.
 * It never reports env values, ids, tokens or customer data. Results are cached
 * per warm instance for CHECKS_TTL_MS.
 */
import Stripe from 'stripe';
import { dbConfigured, countMints, countPendingDiscordSyncOlderThan, countUndeliveredEmails, lastOpsEvent } from './db.js';
import { ENTITLEMENT_MAP } from './entitlements.js';
import { REQUIRED_STRIPE_EVENTS } from '../webhooks/stripe.js';

export const PROBE_TIMEOUT_MS = 3000;
const CHECKS_TTL_MS = 30_000;
const CRON_STALE_MS = 36 * 60 * 60_000;
const STRIPE_API_VERSION = '2023-10-16';

/**
 * Env names whose absence breaks taking money or delivering what was paid for.
 * A missing or misnamed one makes /api/health return ok:false (503).
 */
export const MONEY_PATH_ENV = [
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'PAYPAL_BUSINESS_EMAIL',
  'CROSSMINT_API_KEY', 'CROSSMINT_COLLECTION_ID', 'CROSSMINT_WEBHOOK_SECRET',
  'RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'CRON_SECRET',
];

/** Accepted alternative names: the requirement is met when any one is set. */
export const ENV_ALIASES = { SUPABASE_SECRET_KEY: ['SUPABASE_SERVICE_ROLE_KEY'] };

const norm = (k) => String(k).toUpperCase().replace(/-/g, '_');

/**
 * { complete, missing_required, misnamed: [{ found, expected }] }. NAMES ONLY.
 * `misnamed` flags a required name that is unset while another key matches it
 * case-insensitively or with '-'/'_' swapped (e.g. `Stripe_Webhook_Secret`).
 */
export function envReport(required, env = process.env) {
  const keys = Object.keys(env);
  const missing = [];
  const misnamed = [];
  for (const name of required) {
    const accepted = [name, ...(ENV_ALIASES[name] ?? [])];
    if (accepted.some((k) => Boolean(env[k]))) continue;
    missing.push(name);
    const want = new Set(accepted.map(norm));
    for (const k of keys) {
      if (!accepted.includes(k) && want.has(norm(k)) && env[k]) misnamed.push({ found: k, expected: name });
    }
  }
  return { complete: missing.length === 0, missing_required: missing, misnamed };
}

/** Reject after `ms` (the underlying work is abandoned, not cancelled). */
export function withTimeout(promise, ms = PROBE_TIMEOUT_MS, what = 'probe') {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

const signal = () => globalThis.AbortSignal.timeout(PROBE_TIMEOUT_MS);

// ── Probes ───────────────────────────────────────────────────────────────────

/** Stripe: is the live endpoint subscribed to every event the handler needs? */
export async function probeStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  const base = { webhook_secret: Boolean(process.env.STRIPE_WEBHOOK_SECRET) };
  if (!key) return { ...base, api: 'unconfigured', webhook_endpoint: 'unknown', webhook_events_ok: null, missing_events: [] };
  const stripe = new Stripe(key, { apiVersion: STRIPE_API_VERSION, timeout: PROBE_TIMEOUT_MS, maxNetworkRetries: 0 });
  const list = await withTimeout(stripe.webhookEndpoints.list({ limit: 20 }), PROBE_TIMEOUT_MS, 'stripe');
  const endpoint = (list?.data ?? []).find(
    (e) => String(e?.url ?? '').replace(/\/+$/, '').endsWith('/api/webhooks/stripe') && e?.status === 'enabled');
  if (!endpoint) {
    return { ...base, api: 'ok', webhook_endpoint: 'missing', webhook_events_ok: false, missing_events: [...REQUIRED_STRIPE_EVENTS] };
  }
  const enabled = new Set(endpoint.enabled_events ?? []);
  const missing = enabled.has('*') ? [] : REQUIRED_STRIPE_EVENTS.filter((e) => !enabled.has(e));
  return { ...base, api: 'ok', webhook_endpoint: 'found', webhook_events_ok: missing.length === 0, missing_events: missing };
}

/** Crossmint: does the configured collection answer with this API key? */
export async function probeCrossmint() {
  const base = { webhook_secret: Boolean(process.env.CROSSMINT_WEBHOOK_SECRET) };
  const key = process.env.CROSSMINT_API_KEY;
  const collection = process.env.CROSSMINT_COLLECTION_ID;
  if (!key || !collection) return { ...base, crossmint: 'unconfigured' };
  const host = process.env.CROSSMINT_ENV === 'staging' ? 'https://staging.crossmint.com/api' : 'https://www.crossmint.com/api';
  const res = await fetch(`${host}/2022-06-09/collections/${encodeURIComponent(collection)}`, {
    headers: { 'X-API-KEY': key }, signal: signal(),
  });
  return { ...base, crossmint: res?.ok ? 'ok' : 'error' };
}

/** Discord: is the bot in the guild, and does every role env name a real role? */
export async function probeDiscord() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const guild = process.env.DISCORD_GUILD_ID;
  const roleEnvs = [...new Set(Object.values(ENTITLEMENT_MAP).map((c) => c.discordRoleEnv))];
  const unknownRoles = Object.fromEntries(roleEnvs.map((n) => [n, process.env[n] ? null : 'unset']));
  if (!token || !guild) return { bot_in_guild: null, roles_exist_in_guild: unknownRoles, status: 'unconfigured' };

  const headers = { Authorization: `Bot ${token}` };
  const base = `https://discord.com/api/v10/guilds/${encodeURIComponent(guild)}`;
  const [g, r] = await Promise.allSettled([
    fetch(base, { headers, signal: signal() }),
    fetch(`${base}/roles`, { headers, signal: signal() }).then(async (res) => (res?.ok ? res.json() : null)),
  ]);
  const botInGuild = g.status === 'fulfilled' ? Boolean(g.value?.ok) : null;
  const roles = r.status === 'fulfilled' && Array.isArray(r.value) ? new Set(r.value.map((x) => String(x?.id))) : null;
  const rolesExist = Object.fromEntries(roleEnvs.map((n) => {
    const id = process.env[n];
    if (!id) return [n, 'unset'];
    return [n, roles ? roles.has(String(id)) : null];
  }));
  return { bot_in_guild: botInGuild, roles_exist_in_guild: rolesExist, status: botInGuild ? 'ok' : 'error' };
}

/** Work that is stuck or waiting. A null count means that query failed. */
export async function probeQueue() {
  if (!dbConfigured()) return null;
  const lastReconcile = lastOpsEvent('cron.reconcile.ok');
  const jobs = {
    failed_mints: countMints({ status: 'Failed' }),
    failed_mints_over_24h: countMints({ status: 'Failed', olderThanMinutes: 24 * 60 }),
    stuck_sent_over_1h: countMints({ status: 'Sent', olderThanMinutes: 60 }),
    // Payments in the last 72 h that the last reconcile found with no mint row
    // and could not dead-letter into retry-mints (recovered ones are Failed rows).
    orphan_payments_72h: lastReconcile.then((e) => (e ? Number(e.fields?.Detail?.orphanErrors ?? 0) : null)),
    pending_discord_sync_over_24h: countPendingDiscordSyncOlderThan(24),
    emails_undelivered: countUndeliveredEmails(),
  };
  const names = Object.keys(jobs);
  const settled = await Promise.allSettled(names.map((n) => withTimeout(jobs[n], PROBE_TIMEOUT_MS, n)));
  return Object.fromEntries(names.map((n, i) => [n, settled[i].status === 'fulfilled' ? settled[i].value : null]));
}

/** Last cron heartbeats. `stale` when either is missing or older than 36 h. */
export async function probeCrons(now = Date.now()) {
  const at = (rec) => {
    const t = Date.parse(rec?.fields?.['Created At'] ?? '');
    return Number.isFinite(t) ? t : null;
  };
  let reconcile = null; let retry = null; let degraded = null;
  if (dbConfigured()) {
    const [a, b, c] = await Promise.allSettled([
      withTimeout(lastOpsEvent('cron.reconcile.ok'), PROBE_TIMEOUT_MS, 'reconcile heartbeat'),
      withTimeout(lastOpsEvent('cron.retry_mints.ok'), PROBE_TIMEOUT_MS, 'retry heartbeat'),
      withTimeout(lastOpsEvent('cron.retry_mints.degraded'), PROBE_TIMEOUT_MS, 'retry degraded'),
    ]);
    reconcile = a.status === 'fulfilled' ? at(a.value) : null;
    retry = b.status === 'fulfilled' ? at(b.value) : null;
    degraded = c.status === 'fulfilled' ? at(c.value) : null;
  }
  const iso = (t) => (t ? new Date(t).toISOString() : null);
  const old = (t) => !t || now - t > CRON_STALE_MS;
  return {
    last_reconcile: iso(reconcile),
    last_retry_mints: iso(retry),
    retry_mints: degraded && (!retry || degraded > retry) ? 'degraded' : (retry ? 'ok' : 'missing'),
    stale: old(reconcile) || old(retry),
  };
}

// ── Aggregate ────────────────────────────────────────────────────────────────

let checksCache = null; // { value, at }

/** Test hook. */
export function _resetHealthChecksCache() { checksCache = null; }

/** All authed probes, each bounded by PROBE_TIMEOUT_MS; cached 30 s per instance. */
export async function runHealthChecks() {
  if (checksCache && Date.now() - checksCache.at < CHECKS_TTL_MS) return checksCache.value;
  const probes = { stripe: probeStripe, mint: probeCrossmint, discord: probeDiscord, queue: probeQueue, crons: probeCrons };
  const names = Object.keys(probes);
  const settled = await Promise.allSettled(names.map((n) => withTimeout(Promise.resolve().then(probes[n]), PROBE_TIMEOUT_MS + 500, n)));
  const value = {};
  names.forEach((n, i) => {
    if (settled[i].status === 'fulfilled') { value[n] = settled[i].value; return; }
    console.error(`[health] ${n} probe failed: ${settled[i].reason?.message}`);
    value[n] = { status: 'error' };
  });
  // A failed probe must still answer the fields ok/503 reads.
  if (value.stripe.status === 'error') {
    value.stripe = { api: 'error', webhook_secret: Boolean(process.env.STRIPE_WEBHOOK_SECRET), webhook_endpoint: 'unknown', webhook_events_ok: null, missing_events: [] };
  }
  if (value.mint.status === 'error') value.mint = { crossmint: 'error', webhook_secret: Boolean(process.env.CROSSMINT_WEBHOOK_SECRET) };
  if (value.crons.status === 'error') value.crons = { last_reconcile: null, last_retry_mints: null, retry_mints: 'missing', stale: true };
  checksCache = { value, at: Date.now() };
  return value;
}

/**
 * The reasons (names only) the pipeline is NOT ready. Empty ⇒ ok.
 * @param {{database: string, env: object, checks: object}} r
 */
export function readinessProblems({ database, env, checks }) {
  const problems = [];
  if (database !== 'ok') problems.push('database');
  const moneyMissing = env.missing_required.filter((n) => MONEY_PATH_ENV.includes(n));
  const moneyMisnamed = env.misnamed.filter((m) => MONEY_PATH_ENV.includes(m.expected));
  if (moneyMissing.length || moneyMisnamed.length) problems.push('money_path_env');
  if (checks.stripe?.webhook_events_ok === false) problems.push('stripe_webhook_events');
  if (!process.env.CROSSMINT_WEBHOOK_SECRET) problems.push('crossmint_webhook_secret');
  if (checks.crons?.stale !== false) problems.push('crons_stale');
  if ((checks.queue?.failed_mints_over_24h ?? 0) > 0) problems.push('failed_mints_over_24h');
  return problems;
}
