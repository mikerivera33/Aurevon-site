/**
 * Alert router behaviour. Must be a safe no-op when unconfigured, must never
 * throw into a caller, routes by severity (webhook ≥ warn, owner email ≥ high),
 * dedupes both sinks on dedupeKey via ops_events, and never ships an email
 * address to a sink.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../db.js', () => ({
  dbConfigured: vi.fn(() => true),
  lastOpsEvent: vi.fn().mockResolvedValue(null),
  recordOpsEvent: vi.fn().mockResolvedValue({ id: 'ops_1', fields: {} }),
}));

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendAlert, defaultSeverity, stripPii } from '../alert.js';
import * as db from '../db.js';

const SAVED = { ...process.env };
const WEBHOOK = 'https://hooks.example.com/abc';
const RESEND = 'https://api.resend.com/emails';

function wireBothSinks() {
  process.env.ALERT_WEBHOOK_URL = WEBHOOK;
  process.env.OWNER_ALERT_EMAIL = 'owner@aurevon.test';
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.RESEND_FROM_EMAIL = 'alerts@aurevon.test';
}

function stubFetch(impl = async () => ({ ok: true, status: 200 })) {
  const calls = [];
  const fn = vi.fn(async (url, opts) => { calls.push({ url, opts, body: JSON.parse(opts.body) }); return impl(url, opts); });
  vi.stubGlobal('fetch', fn);
  return calls;
}

let errSpy;
beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ['ALERT_WEBHOOK_URL', 'OWNER_ALERT_EMAIL', 'RESEND_API_KEY', 'RESEND_FROM_EMAIL']) delete process.env[k];
  db.dbConfigured.mockReturnValue(true);
  db.lastOpsEvent.mockResolvedValue(null);
  db.recordOpsEvent.mockResolvedValue({ id: 'ops_1', fields: {} });
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { process.env = { ...SAVED }; vi.unstubAllGlobals(); errSpy.mockRestore(); });

describe('sendAlert — legacy contract', () => {
  it('does not call fetch when no sink is configured (webhook + email skipped)', async () => {
    const calls = stubFetch();
    const res = await sendAlert('stripe.mint_failed', { sessionId: 'cs_1' });
    expect(res.sinks).toEqual({ webhook: 'skipped', email: 'skipped' });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('posts a Slack-compatible payload with event + detail when configured', async () => {
    process.env.ALERT_WEBHOOK_URL = WEBHOOK;
    const calls = stubFetch();
    const res = await sendAlert('reconcile.errors', { count: 3 });
    expect(res.ok).toBe(true);
    expect(res.sinks.webhook).toBe('sent');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(WEBHOOK);
    expect(calls[0].body.text).toContain('reconcile.errors');
    expect(calls[0].body.text).toContain('count=3');
    expect(calls[0].body.content).toBe(calls[0].body.text);
    expect(calls[0].body.event).toBe('reconcile.errors');
    expect(calls[0].body.detail).toEqual({ count: 3 });
  });

  it('swallows send failures and returns an error result instead of throwing', async () => {
    process.env.ALERT_WEBHOOK_URL = WEBHOOK;
    stubFetch(async () => { throw new Error('network down'); });
    const res = await sendAlert('paypal.mint_failed', { txnId: 'pp_1' });
    expect(res.ok).toBe(false);
    expect(res.sinks.webhook).toBe('failed');
    expect(res.error).toBe('network down');
  });
});

describe('sendAlert — always logs [ALERT]', () => {
  it('logs event + severity even with no sink configured', async () => {
    stubFetch();
    await sendAlert('stripe.mint_failed', { sessionId: 'cs_1' });
    const line = errSpy.mock.calls.find((c) => c[0] === '[ALERT]');
    expect(line).toBeDefined();
    expect(line[1]).toBe('stripe.mint_failed');
    expect(line[2]).toBe('critical');
  });

  it('the log line carries no email address', async () => {
    stubFetch();
    await sendAlert('stripe.mint_failed', { email: 'buyer@example.com', error: 'bad buyer@example.com' });
    const logged = JSON.stringify(errSpy.mock.calls);
    expect(logged).not.toContain('buyer@example.com');
  });
});

describe('severity routing', () => {
  it('critical → both sinks (webhook + owner email with the subject format)', async () => {
    wireBothSinks();
    const calls = stubFetch();
    const res = await sendAlert('stripe.mint_failed', { transactionId: 'cs_1' });
    expect(res.severity).toBe('critical');
    expect(res.sinks).toEqual({ webhook: 'sent', email: 'sent' });
    expect(calls.map((c) => c.url).sort()).toEqual([RESEND, WEBHOOK].sort());
    const mail = calls.find((c) => c.url === RESEND);
    expect(mail.body.subject).toBe('[Aurevon ALERT critical] stripe.mint_failed');
    expect(mail.body.to).toEqual(['owner@aurevon.test']);
    expect(mail.body.from).toBe('alerts@aurevon.test');
    expect(mail.opts.headers.Authorization).toBe('Bearer re_test_key');
    expect(mail.opts.signal).toBeInstanceOf(globalThis.AbortSignal);
    expect(calls.find((c) => c.url === WEBHOOK).opts.signal).toBeInstanceOf(globalThis.AbortSignal);
  });

  it('high (the default) → both sinks', async () => {
    wireBothSinks();
    const calls = stubFetch();
    const res = await sendAlert('reconcile.errors', { count: 1 });
    expect(res.severity).toBe('high');
    expect(calls).toHaveLength(2);
  });

  it('warn → only the webhook, no owner email', async () => {
    wireBothSinks();
    const calls = stubFetch();
    const res = await sendAlert('stripe.monthly_change_held', { subId: 'sub_1' });
    expect(res.severity).toBe('warn');
    expect(res.sinks).toEqual({ webhook: 'sent', email: 'skipped' });
    expect(calls.map((c) => c.url)).toEqual([WEBHOOK]);
  });

  it('info → neither sink, but still recorded in ops_events', async () => {
    wireBothSinks();
    const calls = stubFetch();
    const res = await sendAlert('reconcile.orphans_recovered', { count: 2 });
    expect(res.severity).toBe('info');
    expect(calls).toHaveLength(0);
    expect(db.recordOpsEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'reconcile.orphans_recovered', severity: 'info' }));
  });

  it('an explicit severity always wins over the default map', async () => {
    wireBothSinks();
    const calls = stubFetch();
    const res = await sendAlert('stripe.mint_failed', { id: 1 }, { severity: 'warn' });
    expect(res.severity).toBe('warn');
    expect(calls.map((c) => c.url)).toEqual([WEBHOOK]);
  });

  it("an explicit 'warning' is the warn level (webhook only), and an unknown level falls back to the map", async () => {
    wireBothSinks();
    const calls = stubFetch();
    const res = await sendAlert('retry_mints.legacy_row_skipped', { rowId: 'r1' }, { severity: 'warning' });
    expect(res.severity).toBe('warn');
    expect(calls.map((c) => c.url)).toEqual([WEBHOOK]);
    const unknown = await sendAlert('stripe.mint_failed', {}, { severity: 'bogus' });
    expect(unknown.severity).toBe('critical');
  });

  it('owner email needs all of OWNER_ALERT_EMAIL + RESEND_API_KEY + RESEND_FROM_EMAIL', async () => {
    wireBothSinks();
    delete process.env.RESEND_FROM_EMAIL;
    const calls = stubFetch();
    const res = await sendAlert('stripe.mint_failed', {});
    expect(res.sinks.email).toBe('skipped');
    expect(calls.map((c) => c.url)).toEqual([WEBHOOK]);
  });

  it.each([
    ['stripe.mint_failed', 'critical'], ['crossmint.mint_failed_webhook', 'critical'],
    ['retry_mints.email_failed', 'critical'], ['discord.role_grant_failed', 'critical'],
    ['paypal.payment_marker_failed', 'critical'], ['stripe.pipeline_crashed', 'critical'],
    ['crossmint.webhook_unconfigured', 'critical'], ['stripe.paid_session_no_email', 'critical'],
    ['paypal.idempotency_lookup_failed', 'critical'], ['retry_mints.gave_up', 'critical'],
    ['paypal.monthly_change_held', 'warn'], ['stripe.checkout_awaiting_payment', 'warn'],
    ['reconcile.stripe_sessions_deferred', 'warn'], ['stripe.renewal_refund_ignored', 'warn'],
    ['crossmint.webhook_unmatched', 'warn'], ['stripe.refund_unmatched', 'warn'],
    ['reconcile.stripe_sessions_recovered', 'info'], ['stripe.entitlement_revoked', 'info'],
    ['cron.reconcile.ok', 'info'], ['cron.retry_mints.ok', 'info'],
    ['reconcile.errors', 'high'], ['retry_mints.legacy_row_skipped', 'high'], ['cron.retry_mints.degraded', 'high'],
  ])('defaultSeverity(%s) = %s', (event, sev) => {
    expect(defaultSeverity(event)).toBe(sev);
  });
});

describe('dedupe', () => {
  it('suppresses BOTH sinks on a repeat within 60 min (high); the first goes out', async () => {
    wireBothSinks();
    const calls = stubFetch();
    db.lastOpsEvent.mockResolvedValueOnce(null);
    const first = await sendAlert('retry_mints.errors', { count: 1 }, { dedupeKey: 'errors:row1' });
    expect(first.deduped).toBe(false);
    expect(calls).toHaveLength(2);

    db.lastOpsEvent.mockResolvedValueOnce({ id: 'o1', fields: { 'Created At': new Date(Date.now() - 30 * 60_000).toISOString() } });
    const second = await sendAlert('retry_mints.errors', { count: 1 }, { dedupeKey: 'errors:row1' });
    expect(second.deduped).toBe(true);
    expect(second.sinks).toEqual({ webhook: 'skipped', email: 'skipped' });
    expect(calls).toHaveLength(2); // no new email, no new webhook
    expect(db.lastOpsEvent).toHaveBeenLastCalledWith('retry_mints.errors', { dedupeKey: 'errors:row1' });
  });

  it('a suppressed repeat is still recorded, under a :suppressed key (window runs from the last delivery)', async () => {
    wireBothSinks();
    stubFetch();
    db.lastOpsEvent.mockResolvedValueOnce({ id: 'o1', fields: { 'Created At': new Date().toISOString() } });
    await sendAlert('retry_mints.errors', { count: 1 }, { dedupeKey: 'k1' });
    expect(db.recordOpsEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'retry_mints.errors', dedupeKey: 'k1:suppressed' }));
  });

  it('sends again once the 60-minute window has passed', async () => {
    wireBothSinks();
    const calls = stubFetch();
    db.lastOpsEvent.mockResolvedValueOnce({ id: 'o1', fields: { 'Created At': new Date(Date.now() - 61 * 60_000).toISOString() } });
    const res = await sendAlert('retry_mints.errors', { count: 1 }, { dedupeKey: 'k1' });
    expect(res.deduped).toBe(false);
    expect(calls).toHaveLength(2);
    expect(db.recordOpsEvent).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: 'k1' }));
  });

  it('critical uses a 15-minute window', async () => {
    wireBothSinks();
    const calls = stubFetch();
    db.lastOpsEvent.mockResolvedValueOnce({ id: 'o1', fields: { 'Created At': new Date(Date.now() - 20 * 60_000).toISOString() } });
    const res = await sendAlert('stripe.pipeline_crashed', { eventId: 'evt_1' }, { severity: 'critical', dedupeKey: 'evt_1' });
    expect(res.deduped).toBe(false);
    expect(calls).toHaveLength(2);

    db.lastOpsEvent.mockResolvedValueOnce({ id: 'o2', fields: { 'Created At': new Date(Date.now() - 10 * 60_000).toISOString() } });
    const again = await sendAlert('stripe.pipeline_crashed', { eventId: 'evt_1' }, { severity: 'critical', dedupeKey: 'evt_1' });
    expect(again.deduped).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('without a dedupeKey there is no lookup and every alert is delivered', async () => {
    wireBothSinks();
    const calls = stubFetch();
    await sendAlert('reconcile.errors', { count: 1 });
    await sendAlert('reconcile.errors', { count: 1 });
    expect(db.lastOpsEvent).not.toHaveBeenCalled();
    expect(calls).toHaveLength(4);
  });

  it('records every alert in ops_events with the stripped detail', async () => {
    stubFetch();
    await sendAlert('stripe.mint_failed', { transactionId: 'cs_1', customerEmail: 'a@b.com' }, { dedupeKey: 'cs_1' });
    expect(db.recordOpsEvent).toHaveBeenCalledWith({
      event: 'stripe.mint_failed', severity: 'critical', dedupeKey: 'cs_1', detail: { transactionId: 'cs_1' },
    });
  });
});

describe('never throws', () => {
  it('when both fetch and the database reject, sinks are attempted and the call resolves', async () => {
    wireBothSinks();
    const calls = stubFetch(async () => { throw new Error('network down'); });
    db.lastOpsEvent.mockRejectedValue(new Error('Supabase 503'));
    db.recordOpsEvent.mockRejectedValue(new Error('Supabase 503'));
    const res = await sendAlert('stripe.mint_failed', { id: 1 }, { dedupeKey: 'k' });
    expect(res.ok).toBe(false);
    expect(res.deduped).toBe(false); // DB failure → no dedupe
    expect(res.sinks).toEqual({ webhook: 'failed', email: 'failed' });
    expect(calls).toHaveLength(2);
  });

  it('a database lookup failure does not block the sinks', async () => {
    wireBothSinks();
    const calls = stubFetch();
    db.lastOpsEvent.mockRejectedValueOnce(new Error('timeout'));
    const res = await sendAlert('stripe.mint_failed', {}, { dedupeKey: 'k' });
    expect(res.sinks).toEqual({ webhook: 'sent', email: 'sent' });
    expect(calls).toHaveLength(2);
  });

  it('an unconfigured database means no dedupe and no ops write, sinks still fire', async () => {
    wireBothSinks();
    const calls = stubFetch();
    db.dbConfigured.mockReturnValue(false);
    const res = await sendAlert('stripe.mint_failed', {}, { dedupeKey: 'k' });
    expect(res.sinks).toEqual({ webhook: 'sent', email: 'sent' });
    expect(db.lastOpsEvent).not.toHaveBeenCalled();
    expect(db.recordOpsEvent).not.toHaveBeenCalled();
    expect(calls).toHaveLength(2);
  });

  it('a non-2xx sink response counts as failed, not thrown', async () => {
    process.env.ALERT_WEBHOOK_URL = WEBHOOK;
    stubFetch(async () => ({ ok: false, status: 400 }));
    const res = await sendAlert('reconcile.errors', {});
    expect(res.sinks.webhook).toBe('failed');
    expect(res.ok).toBe(false);
  });
});

describe('bounded database calls (2.5 s)', () => {
  afterEach(() => vi.useRealTimers());

  it('a dedupe lookup that never resolves: sendAlert resolves within ~3 s and both sinks fire', async () => {
    vi.useFakeTimers();
    wireBothSinks();
    const calls = stubFetch();
    db.lastOpsEvent.mockReturnValue(new Promise(() => {}));
    let settled = null;
    const p = sendAlert('stripe.mint_failed', { id: 1 }, { dedupeKey: 'k' }).then((r) => { settled = r; });
    await vi.advanceTimersByTimeAsync(2400);
    expect(settled).toBeNull(); // still waiting on the bounded lookup
    await vi.advanceTimersByTimeAsync(600);
    await p;
    expect(settled.deduped).toBe(false);
    expect(settled.sinks).toEqual({ webhook: 'sent', email: 'sent' });
    expect(calls).toHaveLength(2);
  });

  it('an ops_events write that never resolves does not hold sendAlert past ~3 s', async () => {
    vi.useFakeTimers();
    process.env.ALERT_WEBHOOK_URL = WEBHOOK;
    stubFetch();
    db.recordOpsEvent.mockReturnValue(new Promise(() => {}));
    let settled = null;
    const p = sendAlert('reconcile.errors', { count: 1 }).then((r) => { settled = r; });
    await vi.advanceTimersByTimeAsync(3000);
    await p;
    expect(settled.sinks.webhook).toBe('sent');
    expect(settled.ok).toBe(true);
  });
});

describe('robust detail serialisation', () => {
  it('a BigInt or circular detail still logs [ALERT] and reaches the sinks', async () => {
    wireBothSinks();
    const calls = stubFetch();
    const circ = { id: 'c1' };
    circ.self = circ;
    const res = await sendAlert('stripe.mint_failed', { amount: 10n, circ });
    expect(errSpy.mock.calls.some((c) => c[0] === '[ALERT]' && c[1] === 'stripe.mint_failed')).toBe(true);
    expect(res.sinks).toEqual({ webhook: 'sent', email: 'sent' });
    const hook = calls.find((c) => c.url === WEBHOOK).body;
    expect(hook.detail.amount).toBe('10');
    expect(hook.detail.circ.id).toBe('c1');
  });

  it('prototype names are not severities (Object.hasOwn)', async () => {
    stubFetch();
    expect((await sendAlert('stripe.mint_failed', {}, { severity: 'constructor' })).severity).toBe('critical');
    expect((await sendAlert('reconcile.errors', {}, { severity: 'toString' })).severity).toBe('high');
  });
});

describe('privacy', () => {
  it('the Discord/Slack payload contains no email address (keys stripped, one level deep; strings redacted)', async () => {
    wireBothSinks();
    const calls = stubFetch();
    await sendAlert('stripe.mint_failed', {
      sessionId: 'cs_1',
      email: 'buyer@example.com',
      customerEmail: 'buyer@example.com',
      to: 'buyer@example.com',
      recipient: 'buyer@example.com',
      nested: { email: 'buyer@example.com', customerEmail: 'buyer@example.com', to: 'x@y.co', ok: 1 },
      error: 'Resend rejected buyer@example.com',
    });
    for (const c of calls) {
      const raw = JSON.stringify(c.body);
      expect(raw).not.toMatch(/@example\.com|x@y\.co/);
    }
    const hook = calls.find((c) => c.url === WEBHOOK).body;
    expect(hook.detail).toEqual({ sessionId: 'cs_1', nested: { ok: 1 }, error: 'Resend rejected [redacted]' });
  });

  it('stripPii drops PII keys case-insensitively and tolerates non-objects', () => {
    expect(stripPii({ Email: 'a@b.co', CustomerEmail: 'a@b.co', id: 'x' })).toEqual({ id: 'x' });
    expect(stripPii(null)).toEqual({});
    expect(stripPii('nope')).toEqual({});
  });
});

describe('call sites', () => {
  it('no caller passes an explicit severity that downgrades a map-critical event', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url)); // api/
    const files = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(join(d, e.name)); }
        else if (e.name.endsWith('.js')) files.push(join(d, e.name));
      }
    };
    walk(root);
    const offenders = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const re = /sendAlert\(\s*'([^']+)'/g;
      let m;
      while ((m = re.exec(src))) {
        if (defaultSeverity(m[1]) !== 'critical') continue;
        const call = src.slice(m.index, m.index + 400).split('.catch')[0].split(');')[0];
        const sev = /severity:\s*([^,}\n]+)/.exec(call);
        if (sev && sev[1].trim() !== "'critical'") offenders.push(`${f.slice(root.length)}: ${m[1]} → ${sev[1].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
