/**
 * Authed /api/health readiness: proves the money path is wired, and answers
 * 503 (authed only) when it is not. Names and states only, never values.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../db.js', () => ({
  dbConfigured: vi.fn(() => true),
  ping: vi.fn().mockResolvedValue(true),
  countMints: vi.fn().mockResolvedValue(0),
  countPendingDiscordSyncOlderThan: vi.fn().mockResolvedValue(0),
  countUndeliveredEmails: vi.fn().mockResolvedValue(0),
  lastOpsEvent: vi.fn().mockResolvedValue(null),
  recordOpsEvent: vi.fn().mockResolvedValue(null),
}));

const stripeList = vi.hoisted(() => vi.fn());
vi.mock('stripe', () => ({ default: vi.fn(function Stripe() { return { webhookEndpoints: { list: stripeList } }; }) }));

import handler, { _resetHealthCache } from '../../health.js';
import { envReport } from '../health-checks.js';
import { REQUIRED_STRIPE_EVENTS } from '../../webhooks/stripe.js';
import * as db from '../db.js';
import {
  SECRET, HEALTHY_ENV, ROLE_IDS, ALL_STRIPE_EVENTS, applyEnv, healthyFetch, freshHeartbeats, endpointList, mockRes,
} from './helpers/health-fixtures.js';

const SAVED = { ...process.env };
let errSpy;
beforeEach(() => {
  _resetHealthCache();
  vi.clearAllMocks();
  applyEnv(HEALTHY_ENV);
  db.dbConfigured.mockReturnValue(true);
  db.ping.mockResolvedValue(true);
  db.countMints.mockResolvedValue(0);
  db.countPendingDiscordSyncOlderThan.mockResolvedValue(0);
  db.countUndeliveredEmails.mockResolvedValue(0);
  db.lastOpsEvent.mockImplementation(freshHeartbeats());
  stripeList.mockResolvedValue(endpointList());
  healthyFetch();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { process.env = { ...SAVED }; vi.useRealTimers(); vi.unstubAllGlobals(); errSpy.mockRestore(); });

async function authed() {
  const res = mockRes();
  await handler({ method: 'GET', headers: { authorization: `Bearer ${SECRET}` }, query: {} }, res);
  return res;
}

describe('authed /api/health — fully wired', () => {
  it('is 200 + ok with every section populated', async () => {
    const res = await authed();
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.problems).toEqual([]);
    expect(res.body.stripe).toMatchObject({ api: 'ok', webhook_endpoint: 'found', webhook_events_ok: true, missing_events: [] });
    expect(res.body.mint).toEqual({ crossmint: 'ok', webhook_secret: true });
    expect(res.body.discord.bot_in_guild).toBe(true);
    expect(Object.values(res.body.discord.roles_exist_in_guild)).toEqual([true, true, true, true, true]);
    expect(res.body.crons).toMatchObject({ retry_mints: 'ok', stale: false });
    expect(res.body.queue).toEqual({
      failed_mints: 0, failed_mints_over_24h: 0, stuck_sent_over_1h: 0,
      orphan_payments_72h: 0, pending_discord_sync_over_24h: 0, emails_undelivered: 0,
    });
    expect(res.body.alerts).toEqual({ webhook_configured: true, owner_email_configured: false });
  });

  it('sends the probe credentials only in headers, to the expected hosts', async () => {
    const fetchSpy = healthyFetch();
    await authed();
    const urls = fetchSpy.mock.calls.map(([u]) => u);
    expect(urls).toContain(`https://www.crossmint.com/api/2022-06-09/collections/${HEALTHY_ENV.CROSSMINT_COLLECTION_ID}`);
    expect(urls).toContain(`https://discord.com/api/v10/guilds/${HEALTHY_ENV.DISCORD_GUILD_ID}`);
    expect(urls).toContain(`https://discord.com/api/v10/guilds/${HEALTHY_ENV.DISCORD_GUILD_ID}/roles`);
    const cm = fetchSpy.mock.calls.find(([u]) => u.includes('crossmint'));
    expect(cm[1].headers['X-API-KEY']).toBe(HEALTHY_ENV.CROSSMINT_API_KEY);
    const dc = fetchSpy.mock.calls.find(([u]) => u.includes('discord'));
    expect(dc[1].headers.Authorization).toBe(`Bot ${HEALTHY_ENV.DISCORD_BOT_TOKEN}`);
    expect(stripeList).toHaveBeenCalledWith({ limit: 20 });
  });

  it('caches the probes for 30 s per instance', async () => {
    await authed();
    await authed();
    expect(stripeList).toHaveBeenCalledTimes(1);
  });
});

describe('env: misnamed + missing', () => {
  it('detects the production misnaming `Stripe_Webhook_Secret` (names only) and returns 503', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    process.env.Stripe_Webhook_Secret = 'whsec_misnamed_value_xyz';
    const res = await authed();
    expect(res.body.env.misnamed).toEqual([{ found: 'Stripe_Webhook_Secret', expected: 'STRIPE_WEBHOOK_SECRET' }]);
    expect(res.body.env.missing_required).toContain('STRIPE_WEBHOOK_SECRET');
    expect(res.body.env.complete).toBe(false);
    expect(res.statusCode).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.problems).toContain('money_path_env');
    expect(JSON.stringify(res.body)).not.toContain('whsec_misnamed_value_xyz');
  });

  it('envReport also treats `-`/`_` swaps as misnamed and honours the Supabase alias', () => {
    const r = envReport(['CRON_SECRET', 'SUPABASE_SECRET_KEY'], { 'cron-secret': 'x', SUPABASE_SERVICE_ROLE_KEY: 'y' });
    expect(r.misnamed).toEqual([{ found: 'cron-secret', expected: 'CRON_SECRET' }]);
    expect(r.missing_required).toEqual(['CRON_SECRET']);
    expect(envReport(['A_B'], { A_B: 'set', a_b: 'other' }).misnamed).toEqual([]);
  });

  it('a missing money-path var is 503; a missing non-money var is reported but stays 200', async () => {
    delete process.env.CROSSMINT_API_KEY;
    let res = await authed();
    expect(res.statusCode).toBe(503);
    expect(res.body.problems).toContain('money_path_env');

    _resetHealthCache();
    applyEnv(HEALTHY_ENV);
    delete process.env.DISCORD_INVITE_URL;
    res = await authed();
    expect(res.statusCode).toBe(200);
    expect(res.body.env.missing_required).toEqual(['DISCORD_INVITE_URL']);
  });

  it('PayPal REST client id / secret are no longer required; ALERT_WEBHOOK_URL is', async () => {
    delete process.env.ALERT_WEBHOOK_URL;
    const res = await authed();
    expect(res.body.env.missing_required).toEqual(['ALERT_WEBHOOK_URL']);
    expect(res.body.env.missing_required).not.toContain('PAYPAL_CLIENT_ID');
    expect(res.body.env.missing_required).not.toContain('PAYPAL_SECRET');
  });
});

describe('Stripe webhook events', () => {
  it('the fixture lists exactly REQUIRED_STRIPE_EVENTS', () => {
    expect([...ALL_STRIPE_EVENTS].sort()).toEqual([...REQUIRED_STRIPE_EVENTS].sort());
    expect(REQUIRED_STRIPE_EVENTS).toHaveLength(9);
  });

  it('an endpoint subscribed to 3 events → missing_events has 6, webhook_events_ok false, 503', async () => {
    stripeList.mockResolvedValue(endpointList(
      ['checkout.session.completed', 'customer.subscription.deleted', 'invoice.payment_failed']));
    const res = await authed();
    expect(res.body.stripe.webhook_events_ok).toBe(false);
    expect(res.body.stripe.missing_events).toHaveLength(6);
    expect(res.body.stripe.missing_events).not.toContain('checkout.session.completed');
    expect(res.statusCode).toBe(503);
    expect(res.body.problems).toContain('stripe_webhook_events');
  });

  it("'*' means every event is enabled", async () => {
    stripeList.mockResolvedValue(endpointList(['*']));
    const res = await authed();
    expect(res.body.stripe.missing_events).toEqual([]);
    expect(res.body.stripe.webhook_events_ok).toBe(true);
  });

  it('no enabled endpoint ending /api/webhooks/stripe → missing, all 9 events missing, 503', async () => {
    stripeList.mockResolvedValue(endpointList(ALL_STRIPE_EVENTS, { status: 'disabled' }));
    const res = await authed();
    expect(res.body.stripe.webhook_endpoint).toBe('missing');
    expect(res.body.stripe.missing_events).toHaveLength(9);
    expect(res.statusCode).toBe(503);
  });

  it('a Stripe API error is reported, not fatal on its own (webhook_events_ok null)', async () => {
    stripeList.mockRejectedValue(new Error('api down'));
    const res = await authed();
    expect(res.body.stripe.api).toBe('error');
    expect(res.body.stripe.webhook_events_ok).toBeNull();
    expect(res.body.problems).not.toContain('stripe_webhook_events');
  });
});

describe('probes are bounded and isolated', () => {
  it('a hanging Stripe call times out at ~3 s; the other probes still answer', async () => {
    vi.useFakeTimers();
    stripeList.mockReturnValue(new Promise(() => {}));
    const res = mockRes();
    const done = handler({ method: 'GET', headers: { authorization: `Bearer ${SECRET}` }, query: {} }, res);
    await vi.advanceTimersByTimeAsync(4000);
    await done;
    expect(res.body.stripe.api).toBe('error');
    expect(res.body.mint.crossmint).toBe('ok');
    expect(res.body.discord.bot_in_guild).toBe(true);
  });

  it('Crossmint / Discord errors are reported per probe', async () => {
    healthyFetch({ 'crossmint.com': { ok: false, status: 401 }, '/roles': { ok: false, status: 403 } });
    const res = await authed();
    expect(res.body.mint.crossmint).toBe('error');
    expect(res.body.discord.bot_in_guild).toBe(true);
    expect(Object.values(res.body.discord.roles_exist_in_guild)).toEqual([null, null, null, null, null]);
  });

  it('a role env naming a role that is not in the guild is false (ids never printed)', async () => {
    process.env.DISCORD_ROLE_PRODUCT_B = '777777777777777777';
    const res = await authed();
    expect(res.body.discord.roles_exist_in_guild.DISCORD_ROLE_PRODUCT_B).toBe(false);
    expect(res.body.discord.roles_exist_in_guild.DISCORD_ROLE_MONTHLY).toBe(true);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('777777777777777777');
    for (const id of Object.values(ROLE_IDS)) expect(raw).not.toContain(id);
  });

  it('bot not in guild → bot_in_guild false', async () => {
    healthyFetch({ [`guilds/${HEALTHY_ENV.DISCORD_GUILD_ID}`]: { ok: false, status: 403 } });
    const res = await authed();
    expect(res.body.discord.bot_in_guild).toBe(false);
  });
});

describe('readiness rules → 503', () => {
  it('database not ok', async () => {
    db.ping.mockRejectedValue(new Error('down'));
    const res = await authed();
    expect(res.statusCode).toBe(503);
    expect(res.body.problems).toContain('database');
  });

  it('crossmint webhook secret missing', async () => {
    delete process.env.CROSSMINT_WEBHOOK_SECRET;
    const res = await authed();
    expect(res.statusCode).toBe(503);
    expect(res.body.problems).toContain('crossmint_webhook_secret');
    expect(res.body.mint.webhook_secret).toBe(false);
  });

  it('crons stale when a heartbeat is older than 36 h', async () => {
    db.lastOpsEvent.mockImplementation(freshHeartbeats(37 * 60 * 60_000));
    const res = await authed();
    expect(res.body.crons.stale).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(res.body.problems).toContain('crons_stale');
  });

  it('crons stale when a heartbeat is missing', async () => {
    db.lastOpsEvent.mockImplementation(freshHeartbeats(60_000, { 'cron.retry_mints.ok': null }));
    const res = await authed();
    expect(res.body.crons.last_retry_mints).toBeNull();
    expect(res.body.crons.stale).toBe(true);
  });

  it('a newer degraded retry-mints heartbeat is reported as degraded', async () => {
    db.lastOpsEvent.mockImplementation(freshHeartbeats(2 * 60 * 60_000, {
      'cron.retry_mints.degraded': { id: 'd', fields: { 'Created At': new Date().toISOString() } },
    }));
    const res = await authed();
    expect(res.body.crons.retry_mints).toBe('degraded');
  });

  it('failed mints older than 24 h', async () => {
    db.countMints.mockImplementation(async ({ status, olderThanMinutes } = {}) => (status === 'Failed' && olderThanMinutes === 1440 ? 2 : 0));
    const res = await authed();
    expect(res.body.queue.failed_mints_over_24h).toBe(2);
    expect(res.statusCode).toBe(503);
    expect(res.body.problems).toContain('failed_mints_over_24h');
  });

  it('queue counts come from the db helpers with the right arguments; a failing count is null', async () => {
    db.countUndeliveredEmails.mockRejectedValue(new Error('boom'));
    const res = await authed();
    expect(db.countMints).toHaveBeenCalledWith({ status: 'Sent', olderThanMinutes: 60 });
    expect(db.countMints).toHaveBeenCalledWith({ status: 'Failed' });
    expect(db.countPendingDiscordSyncOlderThan).toHaveBeenCalledWith(24);
    expect(res.body.queue.emails_undelivered).toBeNull();
  });
});
