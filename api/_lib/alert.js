/**
 * Alert router for the payment / mint pipeline.
 *
 * Every alert is:
 *   1. logged — `console.error('[ALERT]', event, severity, detail)` (always);
 *   2. recorded in `ops_events` (always attempted; the alert log + dedupe source);
 *   3. delivered to up to two sinks, by severity:
 *        Sink A  ALERT_WEBHOOK_URL (Slack/Discord-compatible)   — warn, high, critical
 *        Sink B  owner email via Resend (OWNER_ALERT_EMAIL)     — high, critical
 *      `info` reaches ops_events only.
 *
 * Severity: an explicit `opts.severity` always wins; otherwise SEVERITY_RULES
 * supplies the default (first match), else 'high'.
 *
 * Dedupe: with `opts.dedupeKey`, both sinks are skipped when the last DELIVERED
 * alert for (event, dedupeKey) is newer than 60 min (15 min for critical).
 * Suppressed repeats are still recorded, under `<dedupeKey>:suppressed`, so the
 * window is measured from the last delivery and a persisting fault re-alerts
 * once per window instead of never again.
 *
 * Contract:
 *   - Never throws. A database failure (unconfigured or erroring) means no
 *     dedupe — the sinks still fire.
 *   - PRIVACY: `detail` should carry IDs / counts only. As a backstop every
 *     outgoing copy (log, ops_events, webhook, email) drops `email` /
 *     `customerEmail` / `to` / `recipient` keys (top level + one nesting level)
 *     and redacts email-shaped substrings.
 *   - Does NOT import email.js (email.js → alert.js would cycle); Sink B is a
 *     plain fetch to the Resend API.
 *
 * @param {string} event  short machine-ish event name, e.g. 'stripe.mint_failed'
 * @param {object} [detail] small bag of IDs/counts (no PII)
 * @param {{severity?: 'info'|'warn'|'high'|'critical', dedupeKey?: string}} [opts]
 * @returns {Promise<{ok: boolean, severity: string, sinks: {webhook: string, email: string}, deduped: boolean, error?: string}>}
 */
import { dbConfigured, lastOpsEvent, recordOpsEvent } from './db.js';

const RANK = { info: 0, warn: 1, high: 2, critical: 3 };
// Spellings callers already use for an explicit severity.
const SEVERITY_ALIASES = { warning: 'warn', error: 'high' };
const SINK_TIMEOUT_MS = 8000;
// Dedupe lookup / ops_events write are on customer + money paths: bounded.
const DB_TIMEOUT_MS = 2500;
const DEDUPE_WINDOW_MS = { default: 60 * 60_000, critical: 15 * 60_000 };

/** Default severity by event name. Ordered: the first match wins. */
export const SEVERITY_RULES = [
  [/\.mint_failed(_webhook)?$/, 'critical'],
  [/\.email_failed$/, 'critical'],
  [/\.role_grant_failed$/, 'critical'],
  [/\.payment_marker_failed$/, 'critical'],
  [/\.pipeline_crashed$/, 'critical'],
  [/\.webhook_unconfigured$/, 'critical'],
  [/\.paid_session_no_email$/, 'critical'],
  [/\.idempotency_lookup_failed$/, 'critical'],
  [/^retry_mints\.gave_up$/, 'critical'],
  [/_held/, 'warn'],
  [/awaiting/, 'warn'],
  [/deferred/, 'warn'],
  [/ignored/, 'warn'],
  [/unmatched/, 'warn'],
  [/recovered$/, 'info'],
  [/\.entitlement_revoked$/, 'info'],
  [/^cron\..+\.ok$/, 'info'],
];

/** Default severity for an event (no explicit severity given). */
export function defaultSeverity(event) {
  for (const [re, sev] of SEVERITY_RULES) if (re.test(String(event))) return sev;
  return 'high';
}

const PII_KEYS = new Set(['email', 'customeremail', 'to', 'recipient']);
const EMAIL_RE = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[a-z]{2,}/gi;

function scrubValue(v) {
  return typeof v === 'string' ? v.replace(EMAIL_RE, '[redacted]') : v;
}

/** Drop PII keys (top level + one nesting level) and redact email-shaped strings. */
export function stripPii(detail) {
  if (!detail || typeof detail !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(detail)) {
    if (PII_KEYS.has(k.toLowerCase())) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = {};
      for (const [ik, iv] of Object.entries(v)) {
        if (PII_KEYS.has(ik.toLowerCase())) continue;
        inner[ik] = scrubValue(iv);
      }
      out[k] = inner;
    } else if (Array.isArray(v)) {
      out[k] = v.map(scrubValue);
    } else {
      out[k] = scrubValue(v);
    }
  }
  return out;
}

/** JSON.stringify that never throws: BigInt → string, circular refs → '[Circular]'. */
export function safeStringify(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_k, v) => {
      if (typeof v === 'bigint') return v.toString();
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v;
    }) ?? 'null';
  } catch {
    return '"[unserializable]"';
  }
}

/** Plain-JSON, PII-stripped copy of `detail`; never throws. */
function safeDetail(detail) {
  try {
    const plain = JSON.parse(safeStringify(stripPii(detail)));
    return plain && typeof plain === 'object' && !Array.isArray(plain) ? plain : {};
  } catch {
    return { detail: '[unserializable]' };
  }
}

/** Resolve `promise`, or reject after `ms`; the timer never outlives the race. */
function bounded(promise, ms, what) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

function summarize(detail) {
  return Object.entries(detail)
    .map(([k, v]) => `${k}=${v && typeof v === 'object' ? safeStringify(v) : v}`)
    .join(' ');
}

async function isDuplicate(event, dedupeKey, severity) {
  if (!dedupeKey) return false;
  try {
    if (!dbConfigured()) return false;
    const last = await bounded(lastOpsEvent(event, { dedupeKey }), DB_TIMEOUT_MS, 'dedupe lookup');
    const at = Date.parse(last?.fields?.['Created At'] ?? '');
    if (!Number.isFinite(at)) return false;
    const windowMs = severity === 'critical' ? DEDUPE_WINDOW_MS.critical : DEDUPE_WINDOW_MS.default;
    return Date.now() - at < windowMs;
  } catch (err) {
    console.error(`[alert] dedupe lookup failed for "${event}": ${err.message}`);
    return false;
  }
}

async function record(event, severity, dedupeKey, detail) {
  try {
    if (!dbConfigured()) return;
    await bounded(recordOpsEvent({ event, severity, dedupeKey, detail }), DB_TIMEOUT_MS, 'ops_events write');
  } catch (err) {
    console.error(`[alert] ops_events write failed for "${event}": ${err.message}`);
  }
}

async function postWebhook(url, event, severity, detail) {
  const summary = summarize(detail);
  const text = `⚠️ [Aurevon] [${severity}] ${event}${summary ? ` — ${summary}` : ''}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // `text` satisfies Slack incoming webhooks; `content` satisfies Discord
    // (Discord ignores `text` and 400s a body with no `content`/`embeds`).
    body: JSON.stringify({ text, content: text, event, severity, detail, ts: new Date().toISOString() }),
    signal: globalThis.AbortSignal.timeout(SINK_TIMEOUT_MS),
  });
  if (res && res.ok === false) throw new Error(`webhook HTTP ${res.status}`);
}

async function postOwnerEmail(event, severity, detail) {
  const lines = [
    `Event: ${event}`,
    `Severity: ${severity}`,
    `Time: ${new Date().toISOString()}`,
    '',
    ...Object.entries(detail).map(([k, v]) => `${k}: ${v && typeof v === 'object' ? safeStringify(v) : v}`),
  ];
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL,
      to: [process.env.OWNER_ALERT_EMAIL],
      subject: `[Aurevon ALERT ${severity}] ${event}`,
      text: lines.join('\n'),
    }),
    signal: globalThis.AbortSignal.timeout(SINK_TIMEOUT_MS),
  });
  if (res && res.ok === false) throw new Error(`resend HTTP ${res.status}`);
}

export async function sendAlert(event, detail = {}, opts = {}) {
  const sinks = { webhook: 'skipped', email: 'skipped' };
  let severity = 'high';
  let deduped = false;
  let error;
  try {
    const given = opts?.severity;
    const explicit = typeof given === 'string' && Object.hasOwn(SEVERITY_ALIASES, given) ? SEVERITY_ALIASES[given] : given;
    severity = typeof explicit === 'string' && Object.hasOwn(RANK, explicit) ? explicit : defaultSeverity(event);
    const dedupeKey = opts?.dedupeKey ? String(opts.dedupeKey) : undefined;
    const safe = safeDetail(detail);

    console.error('[ALERT]', event, severity, safeStringify(safe));

    deduped = await isDuplicate(event, dedupeKey, severity);

    const tasks = [];
    if (!deduped) {
      const url = process.env.ALERT_WEBHOOK_URL;
      if (url && RANK[severity] >= RANK.warn) {
        tasks.push(postWebhook(url, event, severity, safe).then(
          () => { sinks.webhook = 'sent'; },
          (err) => { sinks.webhook = 'failed'; error ??= err.message; console.error(`[alert] webhook send failed for "${event}": ${err.message}`); },
        ));
      }
      const { OWNER_ALERT_EMAIL, RESEND_API_KEY, RESEND_FROM_EMAIL } = process.env;
      if (OWNER_ALERT_EMAIL && RESEND_API_KEY && RESEND_FROM_EMAIL && RANK[severity] >= RANK.high) {
        tasks.push(postOwnerEmail(event, severity, safe).then(
          () => { sinks.email = 'sent'; },
          (err) => { sinks.email = 'failed'; error ??= err.message; console.error(`[alert] owner email failed for "${event}": ${err.message}`); },
        ));
      }
    }
    tasks.push(record(event, severity, deduped ? `${dedupeKey}:suppressed` : dedupeKey, safe));
    await Promise.allSettled(tasks);
  } catch (err) {
    // Belt and braces: nothing above should throw, but a caller must never fail on an alert.
    error ??= err.message;
    console.error(`[alert] unexpected failure for "${event}": ${err.message}`);
  }
  // ok: no sink failed (a skipped sink is not a failure).
  return { ok: !error, severity, sinks, deduped, ...(error ? { error } : {}) };
}
