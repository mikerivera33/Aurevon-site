/**
 * Stripe-side reconcile (recoverUnrecordedStripeSessions) + the reconcile cron.
 *
 * Every other recovery path starts from a Payments row. If the webhook never
 * wrote one, only Stripe knows the sale happened: reconcile lists recent
 * complete Checkout Sessions and runs any settled one with no Payments row
 * through the webhook's own recordCheckoutPayment → fulfilCheckout — exactly
 * once, however often it runs.
 *
 * Harness: real stripe.js / fulfil / tiers / entitlements / crossmint / email;
 * in-memory db, faked Stripe SDK, alerts, Discord bot, Engage and fetch.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';

const store = vi.hoisted(() => ({}));
const sessionsList = vi.hoisted(() => vi.fn());

vi.mock('../db.js', async () => (await import('./helpers/nft-harness.js')).makeFakeDb(store));
vi.mock('../airtable-import.js', () => ({
  airtableImportEnabled: vi.fn(() => false), countAirtableMintsByPrefix: vi.fn(),
  importFromAirtable: vi.fn(), importHasProblems: vi.fn(() => false),
}));
vi.mock('../alert.js', () => ({ sendAlert: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('../discord-bot.js', () => ({ addRoleToMember: vi.fn(), addMemberToGuild: vi.fn(), removeRoleFromMember: vi.fn().mockResolvedValue({}) }));
vi.mock('../engage.js', () => ({ onDiscordLinkReminder: vi.fn().mockResolvedValue({}), onSubscriptionCancelled: vi.fn().mockResolvedValue({}) }));
vi.mock('stripe', () => ({
  default: class StripeMock {
    constructor() {
      this.checkout = { sessions: { list: sessionsList } };
      this.subscriptions = { update: vi.fn().mockResolvedValue({}), retrieve: vi.fn().mockResolvedValue({ status: 'active' }) };
      this.customers = { retrieve: vi.fn().mockResolvedValue({}) };
    }
  },
}));

import { resetStore, applyEnv, installFetch, crossmintCalls, resendCalls } from './helpers/nft-harness.js';

const SAVED = { ...process.env };
let db;
let sendAlert;
let discordBot;
let claim;

beforeAll(async () => {
  applyEnv();
  db = await import('../db.js');
  ({ sendAlert } = await import('../alert.js'));
  discordBot = await import('../discord-bot.js');
  claim = await import('../../member/claim.js');
});
afterAll(() => { process.env = { ...SAVED }; vi.unstubAllGlobals(); });

beforeEach(() => {
  resetStore(store);
  applyEnv();
  vi.clearAllMocks();
  installFetch(store);
  sessionsList.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const BUYER = 'lost.buyer@example.com';
const alerted = (event) => sendAlert.mock.calls.filter(([e]) => e === event);

function session(id, overrides = {}) {
  return {
    id,
    object: 'checkout.session',
    status: 'complete',
    payment_status: 'paid',
    mode: 'payment',
    customer_details: { email: BUYER, name: 'Lost Buyer' },
    amount_total: 25000,
    metadata: { tier: 're_full' },
    payment_intent: { id: `pi_${id}`, latest_charge: { id: `ch_${id}`, amount: 25000, amount_refunded: 0, refunded: false, disputed: false } },
    invoice: null,
    ...overrides,
  };
}
const page = (data, hasMore = false) => ({ object: 'list', data, has_more: hasMore });

describe('recoverUnrecordedStripeSessions', () => {
  it('skips silently when STRIPE_SECRET_KEY is unset', async () => {
    delete process.env.STRIPE_SECRET_KEY;

    const out = await claim.recoverUnrecordedStripeSessions();

    expect(out).toEqual(expect.objectContaining({ skipped: true, recovered: 0 }));
    expect(sessionsList).not.toHaveBeenCalled();
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('records and fulfils a complete paid session missing from Payments exactly once (two runs)', async () => {
    sessionsList.mockResolvedValue(page([session('cs_test_lost1')]));

    const first = await claim.recoverUnrecordedStripeSessions({ sinceDays: 3 });

    expect(first).toEqual(expect.objectContaining({ recovered: 1, errors: 0, scanned: 1 }));
    expect(store.payments.get('cs_test_lost1').fields).toEqual(expect.objectContaining({ 'Status': 'Succeeded', 'Pass Type': 're_full' }));
    expect(crossmintCalls(store)).toHaveLength(1);
    expect(store.mints).toHaveLength(1);
    expect(store.mints[0].fields).toEqual(expect.objectContaining({
      'Mint Status': 'Sent', 'NFT Type': 'Aurevon Insider', 'Payment Transaction ID': 'cs_test_lost1', 'Email Delivered': true,
    }));
    expect(resendCalls(store)).toHaveLength(1);
    expect(alerted('reconcile.stripe_sessions_recovered')).toEqual([
      ['reconcile.stripe_sessions_recovered', { count: 1, sessionIds: ['cs_test_lost1'] }, expect.objectContaining({ severity: 'high' })],
    ]);

    const second = await claim.recoverUnrecordedStripeSessions({ sinceDays: 3 });

    expect(second.recovered).toBe(0);
    expect(crossmintCalls(store)).toHaveLength(1);
    expect(resendCalls(store)).toHaveLength(1);
    expect(store.mints).toHaveLength(1);
    expect(alerted('reconcile.stripe_sessions_recovered')).toHaveLength(1);
    expect(JSON.stringify(sendAlert.mock.calls)).not.toContain(BUYER);
  });

  it('lists complete sessions created in the window, 100 per page, with the charge expanded', async () => {
    sessionsList.mockResolvedValue(page([]));
    const before = Math.floor((Date.now() - 3 * 86_400_000) / 1000);

    await claim.recoverUnrecordedStripeSessions({ sinceDays: 3 });

    const params = sessionsList.mock.calls[0][0];
    expect(params).toEqual(expect.objectContaining({ status: 'complete', limit: 100 }));
    expect(params.created.gte).toBeGreaterThanOrEqual(before);
    expect(params.created.gte).toBeLessThanOrEqual(before + 5);
    expect(params.expand).toEqual(expect.arrayContaining(['data.payment_intent.latest_charge']));
    expect(params.starting_after).toBeUndefined();
  });

  it('leaves recorded, unsettled and foreign (no metadata.tier) sessions alone; recovers no_payment_required', async () => {
    store.payments.set('cs_test_known', { id: 'pay_known', fields: { 'Transaction ID': 'cs_test_known', 'Status': 'Succeeded' } });
    sessionsList.mockResolvedValue(page([
      session('cs_test_known'),
      session('cs_test_unpaid', { payment_status: 'unpaid' }),
      session('cs_test_foreign', { metadata: {} }),
      session('cs_test_free', { payment_status: 'no_payment_required', amount_total: 0, payment_intent: null }),
    ]));

    const out = await claim.recoverUnrecordedStripeSessions();

    expect(out).toEqual(expect.objectContaining({ scanned: 4, recovered: 1 }));
    expect([...store.payments.keys()].sort()).toEqual(['cs_test_free', 'cs_test_known']);
    expect(store.mints.map((m) => m.fields['Payment Transaction ID'])).toEqual(['cs_test_free']);
    expect(db.listPaymentTransactionIds).toHaveBeenCalledWith(['cs_test_known', 'cs_test_free']);
  });

  it('does not recover a session whose charge was fully refunded or disputed', async () => {
    sessionsList.mockResolvedValue(page([
      session('cs_test_refunded', { payment_intent: { latest_charge: { amount: 25000, amount_refunded: 25000, refunded: true } } }),
      session('cs_test_disputed', { payment_intent: { latest_charge: { amount: 25000, amount_refunded: 0, disputed: true } } }),
      session('cs_test_subrefund', { mode: 'subscription', payment_intent: null, invoice: { id: 'in_1', charge: { amount: 149900, amount_refunded: 149900 } }, metadata: { tier: 're_retainer' } }),
      session('cs_test_partial', { payment_intent: { latest_charge: { amount: 25000, amount_refunded: 1000, refunded: false } } }),
    ]));

    const out = await claim.recoverUnrecordedStripeSessions();

    expect(out).toEqual(expect.objectContaining({ reversed: 3, recovered: 1 }));
    expect([...store.payments.keys()]).toEqual(['cs_test_partial']);
    expect(crossmintCalls(store)).toHaveLength(1);
  });

  it('a no-NFT tier is recorded and gets its purchase confirmation (no mint)', async () => {
    sessionsList.mockResolvedValue(page([session('cs_test_bogo', { metadata: { tier: 're_bogo' }, amount_total: 29999 })]));

    const out = await claim.recoverUnrecordedStripeSessions();

    expect(out.recovered).toBe(1);
    expect(store.payments.has('cs_test_bogo')).toBe(true);
    expect(crossmintCalls(store)).toHaveLength(0);
    expect(resendCalls(store)).toHaveLength(1);
  });

  it('paginates with starting_after and stops at 5 pages', async () => {
    let n = 0;
    sessionsList.mockImplementation(async () => {
      n++;
      return page([session(`cs_test_p${n}a`, { payment_status: 'unpaid' }), session(`cs_test_p${n}b`, { payment_status: 'unpaid' })], true);
    });

    const out = await claim.recoverUnrecordedStripeSessions();

    expect(sessionsList).toHaveBeenCalledTimes(5);
    expect(sessionsList.mock.calls[1][0].starting_after).toBe('cs_test_p1b');
    expect(sessionsList.mock.calls[4][0].starting_after).toBe('cs_test_p4b');
    expect(out.scanned).toBe(10);
  });

  it('stops after the last page (has_more false)', async () => {
    sessionsList
      .mockResolvedValueOnce(page([session('cs_test_pg1', { payment_status: 'unpaid' })], true))
      .mockResolvedValueOnce(page([session('cs_test_pg2')], false));

    const out = await claim.recoverUnrecordedStripeSessions();

    expect(sessionsList).toHaveBeenCalledTimes(2);
    expect(out.recovered).toBe(1);
  });

  it('a per-session failure is caught and counted, alerted once; other sessions still recover', async () => {
    sessionsList.mockResolvedValue(page([session('cs_test_err1'), session('cs_test_err2'), session('cs_test_ok')]));
    db.createPayment
      .mockRejectedValueOnce(new Error('Supabase 503'))
      .mockRejectedValueOnce(new Error('Supabase 503'));

    const out = await claim.recoverUnrecordedStripeSessions();

    expect(out).toEqual(expect.objectContaining({ errors: 2, recovered: 1 }));
    expect(alerted('reconcile.stripe_session_errors')).toEqual([
      ['reconcile.stripe_session_errors', { count: 2, sessionIds: ['cs_test_err1', 'cs_test_err2'] }, expect.objectContaining({ severity: 'high' })],
    ]);
    expect(crossmintCalls(store)).toHaveLength(1);

    // The next run picks the two up (no Payments row was written for them).
    const again = await claim.recoverUnrecordedStripeSessions();
    expect(again.recovered).toBe(2);
    expect(crossmintCalls(store)).toHaveLength(3);
  });

  it('a Stripe list failure is counted and alerted, never thrown', async () => {
    sessionsList.mockRejectedValueOnce(new Error('Stripe 500'));

    const out = await claim.recoverUnrecordedStripeSessions();

    expect(out).toEqual(expect.objectContaining({ errors: 1, recovered: 0 }));
    expect(alerted('reconcile.stripe_session_errors')).toHaveLength(1);
  });

  it('defers sessions past the time budget to the next run', async () => {
    sessionsList.mockResolvedValue(page([session('cs_test_late1'), session('cs_test_late2')]));

    const out = await claim.recoverUnrecordedStripeSessions({ budgetMs: -1 });

    expect(out).toEqual(expect.objectContaining({ recovered: 0, deferred: 2 }));
    expect(store.payments.size).toBe(0);
    expect(alerted('reconcile.stripe_sessions_deferred')).toHaveLength(1);
  });
});

describe('reconcile cron', () => {
  function mockRes() {
    return {
      statusCode: 0, body: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
      setHeader() { return this; },
      end() { return this; },
    };
  }
  const runReconcile = async () => {
    process.env.CRON_SECRET = 'cron_secret_abcdefghij';
    const res = mockRes();
    await claim.default({ method: 'GET', query: { action: 'reconcile' }, headers: { authorization: 'Bearer cron_secret_abcdefghij' } }, res);
    return res;
  };

  it('recovers unrecorded Stripe sessions and writes the cron.reconcile.ok heartbeat', async () => {
    sessionsList.mockResolvedValue(page([session('cs_test_cron1')]));

    const res = await runReconcile();

    expect(res.statusCode).toBe(200);
    expect(res.body.report.stripeSessions).toEqual(expect.objectContaining({ recovered: 1 }));
    expect(crossmintCalls(store)).toHaveLength(1);
    expect(db.recordOpsEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'cron.reconcile.ok',
      severity: 'info',
      detail: expect.objectContaining({ stripeSessionsRecovered: 1, errors: 0 }),
    }));
  });

  it('Stripe-session and orphan-recovery error counts reach report.errors, reconcile.errors and the heartbeat', async () => {
    sessionsList.mockResolvedValue(page([session('cs_test_cronerr')]));
    db.createPayment.mockRejectedValueOnce(new Error('Supabase 503')); // the Stripe session fails to record
    db.listPaymentsSince.mockResolvedValueOnce([
      { id: 'pay_o', fields: { 'Customer Email': BUYER, 'Pass Type': 'full', 'Transaction ID': 'cs_test_orph', Status: 'Succeeded' } },
    ]);
    const realLookup = db.findMintByPaymentId.getMockImplementation();
    db.findMintByPaymentId.mockImplementation(async (t) => {
      if (t === 'cs_test_orph') throw new Error('Supabase 503'); // the orphan lookup fails
      return realLookup(t);
    });

    const res = await runReconcile();

    expect(res.statusCode).toBe(200);
    expect(res.body.report.errors).toEqual(expect.arrayContaining(['stripe_session_errors: 1', 'orphan_errors: 1']));
    expect(alerted('reconcile.errors')).toEqual([
      ['reconcile.errors', expect.objectContaining({ count: res.body.report.errors.length })],
    ]);
    expect(db.recordOpsEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'cron.reconcile.ok',
      detail: expect.objectContaining({ orphanErrors: 1, stripeSessionErrors: 1, errors: res.body.report.errors.length }),
    }));
    expect(JSON.stringify(sendAlert.mock.calls)).not.toContain(BUYER);
    db.findMintByPaymentId.mockImplementation(realLookup);
  });

  it('a clean run adds no recovery-error keys to the heartbeat', async () => {
    sessionsList.mockResolvedValue(page([]));

    await runReconcile();

    const [{ detail }] = db.recordOpsEvent.mock.calls.map(([e]) => e).filter((e) => e.event === 'cron.reconcile.ok');
    expect(detail).not.toHaveProperty('orphanErrors');
    expect(detail).not.toHaveProperty('stripeSessionErrors');
    expect(alerted('reconcile.errors')).toHaveLength(0);
  });

  it('a heartbeat write failure does not fail the run', async () => {
    sessionsList.mockResolvedValue(page([]));
    db.recordOpsEvent.mockRejectedValueOnce(new Error('Supabase 503'));

    const res = await runReconcile();

    expect(res.statusCode).toBe(200);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/heartbeat cron\.reconcile\.ok not recorded/));
  });

  it('revokes a lapsed monthly member with no Entitlement Expires At once the grace window from Discord Sync At ?? Join Date has passed', async () => {
    sessionsList.mockResolvedValue(page([]));
    const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString();
    db.listLapsedMonthlyWithoutExpiry.mockResolvedValueOnce([
      { id: 'memOld', fields: { Email: 'old@example.com', 'Discord ID': 'd_old', 'Billing State': 'cancelled', 'Discord Sync At': daysAgo(30), 'Join Date': daysAgo(1) } },
      { id: 'memJoin', fields: { Email: 'join@example.com', 'Billing State': 'past_due', 'Join Date': daysAgo(20) } },
      { id: 'memFresh', fields: { Email: 'fresh@example.com', 'Discord ID': 'd_fresh', 'Billing State': 'cancelled', 'Discord Sync At': daysAgo(2), 'Join Date': daysAgo(60) } },
    ]);

    const res = await runReconcile();

    expect(res.body.report).toEqual(expect.objectContaining({ revokeChecked: 3, revokeApplied: 2 }));
    expect(discordBot.removeRoleFromMember).toHaveBeenCalledTimes(1);
    expect(discordBot.removeRoleFromMember).toHaveBeenCalledWith('d_old', 'role_m');
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith('old@example.com', 'revoked');
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith('join@example.com', 'revoked');
    expect(db.updateDiscordSyncStatus).not.toHaveBeenCalledWith('fresh@example.com', 'revoked');
    const logged = JSON.stringify([...console.log.mock.calls, ...console.error.mock.calls]);
    expect(logged).not.toContain('old@example.com');
  });

  describe('nightly re-revocation (final fix 11)', () => {
    const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString();
    // A tiny members table behind listOutOfSyncEntitlements / updateEntitlementState.
    const installMembers = (rows) => {
      const members = new Map(rows.map((r) => [r.fields.Email, r]));
      db.listOutOfSyncEntitlements.mockImplementation(async () => [...members.values()]
        .filter((m) => m.fields['Entitlement Status'] === 'active'));
      db.updateEntitlementState.mockImplementation(async (email, { status }) => {
        if (status !== undefined) members.get(email).fields['Entitlement Status'] = status;
        return {};
      });
      return members;
    };
    afterEach(() => {
      db.listOutOfSyncEntitlements.mockImplementation(async () => []);
      db.updateEntitlementState.mockImplementation(async () => ({}));
    });
    const lapsed = (email, discordId) => ({ id: `mem_${discordId}`, fields: {
      Email: email, 'Discord ID': discordId, 'Entitlement Type': 'monthly_membership', 'Entitlement Status': 'active',
      'Billing State': 'cancelled', 'Entitlement Expires At': daysAgo(30),
    } });

    it('marks the entitlement revoked after a successful revocation, so a second run does not revoke again', async () => {
      sessionsList.mockResolvedValue(page([]));
      const members = installMembers([lapsed('gone@example.com', 'd_gone')]);

      const first = await runReconcile();
      expect(first.body.report).toEqual(expect.objectContaining({ revokeChecked: 1, revokeApplied: 1 }));
      expect(db.updateEntitlementState).toHaveBeenCalledWith('gone@example.com', { status: 'revoked' });
      expect(members.get('gone@example.com').fields['Entitlement Status']).toBe('revoked');

      const second = await runReconcile();
      expect(second.body.report).toEqual(expect.objectContaining({ revokeChecked: 0, revokeApplied: 0 }));
      expect(discordBot.removeRoleFromMember).toHaveBeenCalledTimes(1);
    });

    it('a failed role removal stays active so the next run retries it', async () => {
      sessionsList.mockResolvedValue(page([]));
      const members = installMembers([lapsed('stuck@example.com', 'd_stuck')]);
      discordBot.removeRoleFromMember.mockRejectedValueOnce(new Error('Discord bot (500): x'));

      await runReconcile();
      expect(db.updateEntitlementState).not.toHaveBeenCalledWith('stuck@example.com', { status: 'revoked' });
      expect(members.get('stuck@example.com').fields['Entitlement Status']).toBe('active');

      await runReconcile();
      expect(discordBot.removeRoleFromMember).toHaveBeenCalledTimes(2);
      expect(members.get('stuck@example.com').fields['Entitlement Status']).toBe('revoked');
    });
  });
});
