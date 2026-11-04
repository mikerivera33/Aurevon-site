/**
 * NFT pipeline failure modes (Pro Retainer → Aurevon Ember), through the real
 * Stripe and PayPal handlers and fulfilNft directly. Every expected failure
 * alerts and leaves an honest record; none of them throws or double-mints.
 *
 * Same harness as nft-golden-path.test.js: real tiers / entitlements /
 * crossmint / email / fulfil / discord; faked db, alerts, Discord bot,
 * Stripe SDK and fetch.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

const store = vi.hoisted(() => ({}));

vi.mock('../db.js', async () => (await import('./helpers/nft-harness.js')).makeFakeDb(store));
vi.mock('../airtable-import.js', () => ({
  airtableImportEnabled: vi.fn(() => false), countAirtableMintsByPrefix: vi.fn(),
  importFromAirtable: vi.fn(), importHasProblems: vi.fn(() => false),
}));
vi.mock('../alert.js', () => ({ sendAlert: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('../discord-bot.js', () => ({ addRoleToMember: vi.fn(), addMemberToGuild: vi.fn(), removeRoleFromMember: vi.fn() }));
vi.mock('stripe', () => ({
  default: class StripeMock {
    constructor() {
      this.subscriptions = { update: vi.fn().mockResolvedValue({}), retrieve: vi.fn().mockResolvedValue({ status: 'active' }) };
      this.customers = { retrieve: vi.fn().mockResolvedValue({ email: 'x@example.com' }) };
    }
  },
}));

import { resetStore, applyEnv, installFetch, crossmintCalls, resendCalls, deliver, txnId } from './helpers/nft-harness.js';
import { serialFromReference, nextRetryAt } from '../fulfil.js';

const SAVED = { ...process.env };
let db;
let sendAlert;
let fulfilNft;

beforeAll(async () => {
  applyEnv(); // before the first import of crossmint.js
  db = await import('../db.js');
  ({ sendAlert } = await import('../alert.js'));
  ({ fulfilNft } = await import('../fulfil.js'));
});
afterAll(() => { process.env = { ...SAVED }; vi.unstubAllGlobals(); });

beforeEach(() => {
  resetStore(store);
  applyEnv();
  vi.clearAllMocks();
  installFetch(store);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const BUYER = 'ember.buyer@example.com';
const RETAINER = { stripe: 're_retainer', paypal: 'retainer' };
const alerted = (event) => sendAlert.mock.calls.filter(([e]) => e === event);

describe.each(['stripe', 'paypal'])('%s retainer failure modes', (provider) => {
  const run = (tag) => {
    const id = txnId(provider, tag);
    return deliver[provider]({ id, tier: RETAINER[provider], amount: 1499, email: BUYER }).then(() => id);
  };

  it('Crossmint 500 → row Failed, *.mint_failed alert, a "pending" email (no Discord link)', async () => {
    store.crossmintStatus = 500;
    const id = await run('cm500');

    expect(crossmintCalls(store)).toHaveLength(1);
    expect(store.mints).toHaveLength(1);
    const row = store.mints[0].fields;
    expect(row['Mint Status']).toBe('Failed');
    expect(row['Payment Transaction ID']).toBe(id);
    expect(row['Reference']).toBe('EMBER_001');
    expect(row['Notes']).toMatch(/Crossmint error: crossmint unavailable/);
    expect(row['Email Delivered']).toBe(false);
    expect(alerted(`${provider}.mint_failed`)).toHaveLength(1);
    expect(JSON.stringify(sendAlert.mock.calls)).not.toContain(BUYER);

    const emails = resendCalls(store);
    expect(emails).toHaveLength(1);
    expect(emails[0].body.subject).toMatch(/being finalized/);
    expect(emails[0].body.html).not.toContain('action=auth');
    expect(db.updateNftMint).not.toHaveBeenCalledWith(expect.anything(), { 'Email Delivered': true });
  });

  it('Resend fails → *.email_failed alert, row Sent with Email Delivered false', async () => {
    store.resendFails = true;
    await run('rs500');

    expect(store.mints[0].fields['Mint Status']).toBe('Sent');
    expect(store.mints[0].fields['Email Delivered']).toBe(false);
    expect(resendCalls(store)).toHaveLength(1);
    expect(alerted(`${provider}.email_failed`)).toHaveLength(1);
  });

  it('serial counter down → still mints once (no Serial in the description), alerts, MINT_ reference', async () => {
    store.serialFails = true;
    const id = await run('serialdown');

    const mints = crossmintCalls(store);
    expect(mints).toHaveLength(1);
    expect(mints[0].body.metadata.description).not.toMatch(/Serial|null/);
    expect(alerted(`${provider}.serial_failed`)).toHaveLength(1);
    expect(store.mints[0].fields['Mint Status']).toBe('Sent');
    expect(store.mints[0].fields['Reference']).toBe(`MINT_${id.slice(-8)}_EMBER`);
  });

  it('DUPLICATE_REFERENCE after a successful mint → _dup reference + *.serial_collision, never re-minted', async () => {
    // A row already holds EMBER_001 (e.g. imported) while the counter is behind.
    store.mints.push({ id: 'mint_old', fields: { 'Reference': 'EMBER_001', 'Payment Transaction ID': 'cs_test_older' } });
    const id = await run('collide');

    expect(crossmintCalls(store)).toHaveLength(1);
    const row = store.mints.find((r) => r.fields['Payment Transaction ID'] === id);
    expect(row.fields['Reference']).toBe(`EMBER_001_dup${id.slice(-4)}`);
    expect(row.fields['Mint Status']).toBe('Sent');
    expect(alerted(`${provider}.serial_collision`)).toHaveLength(1);
    // The email shows the serial the NFT actually carries on-chain.
    expect(resendCalls(store)[0].body.html).toContain('EMBER_001');
    expect(row.fields['Email Delivered']).toBe(true);
  });
});

describe('fulfilNft recovery paths', () => {
  it('retries a Failed row in place: same serial, same idempotency key, row updated, no new row', async () => {
    store.crossmintStatus = 500;
    await fulfilNft({ transactionId: 'cs_test_retry1', email: BUYER, tier: 'retainer', provider: 'stripe' });
    expect(store.mints[0].fields['Mint Status']).toBe('Failed');

    store.crossmintStatus = 200;
    const res = await fulfilNft({ transactionId: 'cs_test_retry1', email: BUYER, tier: 'retainer', provider: 'stripe' });

    expect(res).toEqual(expect.objectContaining({ minted: true, serial: 'EMBER_001', rowId: store.mints[0].id }));
    expect(store.mints).toHaveLength(1);
    expect(store.mints[0].fields['Mint Status']).toBe('Sent');
    expect(store.mints[0].fields['Retry Count']).toBe(1);
    expect(store.mints[0].fields['Crossmint Action ID']).toMatch(/^act_/);
    expect(store.mints[0].fields['Email Delivered']).toBe(true);
    const mints = crossmintCalls(store);
    expect(mints).toHaveLength(2);
    expect(mints[1].url).toBe(mints[0].url); // same idempotency key
    expect(mints[1].body.metadata.attributes).toEqual(expect.arrayContaining([{ trait_type: 'Serial', value: 'EMBER_001' }]));
    expect(db.nextSerial).toHaveBeenCalledTimes(1);
  });

  it('schedules the backoff: a first failure is due in 15 min, a failed retry in 30 min, a success leaves it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-04T12:00:00.000Z'));
      store.crossmintStatus = 500;
      await fulfilNft({ transactionId: 'cs_test_backoff', email: BUYER, tier: 'retainer', provider: 'stripe' });
      expect(store.mints[0].fields['Next Retry At']).toBe('2026-11-04T12:15:00.000Z');

      vi.setSystemTime(new Date('2026-11-04T12:15:00.000Z'));
      await fulfilNft({ transactionId: 'cs_test_backoff', email: BUYER, tier: 'retainer', provider: 'retry' });
      expect(store.mints[0].fields).toEqual(expect.objectContaining({ 'Retry Count': 1, 'Next Retry At': '2026-11-04T12:45:00.000Z' }));

      store.crossmintStatus = 200;
      vi.setSystemTime(new Date('2026-11-04T12:45:00.000Z'));
      await fulfilNft({ transactionId: 'cs_test_backoff', email: BUYER, tier: 'retainer', provider: 'retry' });
      expect(store.mints[0].fields['Mint Status']).toBe('Sent');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a successful first mint sets no Next Retry At', async () => {
    await fulfilNft({ transactionId: 'cs_test_nobackoff', email: BUYER, tier: 'retainer', provider: 'stripe' });
    expect(store.mints[0].fields['Next Retry At']).toBeUndefined();
  });

  it('DUPLICATE_REFERENCE on a FAILED mint takes one fresh serial (nothing on-chain carries the old one)', async () => {
    store.crossmintStatus = 500;
    store.mints.push({ id: 'mint_old', fields: { 'Reference': 'EMBER_001', 'Payment Transaction ID': 'cs_test_older' } });
    const res = await fulfilNft({ transactionId: 'cs_test_failcollide', email: BUYER, tier: 'retainer', provider: 'stripe' });

    const row = store.mints.find((r) => r.fields['Payment Transaction ID'] === 'cs_test_failcollide');
    expect(row.fields['Reference']).toBe('EMBER_002');
    expect(res.serial).toBe('EMBER_002');
    expect(alerted('stripe.serial_collision')).toHaveLength(0);
  });

  it('DUPLICATE_PAYMENT_MINT (a concurrent run wrote the row) returns it without emailing', async () => {
    db.findMintByPaymentId.mockResolvedValueOnce(null); // both runs passed the lookup
    store.mints.push({ id: 'mint_race', fields: { 'Reference': 'EMBER_009', 'Payment Transaction ID': 'cs_test_race1', 'Mint Status': 'Sent' } });
    const res = await fulfilNft({ transactionId: 'cs_test_race1', email: BUYER, tier: 'retainer', provider: 'stripe' });

    expect(res).toEqual(expect.objectContaining({ minted: true, existing: true, rowId: 'mint_race', serial: 'EMBER_009' }));
    expect(resendCalls(store)).toHaveLength(0);
    // This run's PUT went out once (same idempotency key as the winner's — a no-op on Crossmint).
    expect(crossmintCalls(store)).toHaveLength(1);
    expect(alerted('stripe.mint_row_dropped')).toHaveLength(0);
  });

  it('a concurrent run winning during the _dup fallback insert (DUPLICATE_PAYMENT_MINT) returns its row: no drop alert, no email', async () => {
    db.createNftMint
      .mockImplementationOnce(async () => { throw Object.assign(new Error('dup ref'), { code: 'DUPLICATE_REFERENCE' }); })
      .mockImplementationOnce(async () => {
        // The other run's row lands between our two inserts.
        store.mints.push({ id: 'mint_winner', fields: { 'Reference': 'EMBER_005', 'Payment Transaction ID': 'cs_test_race2', 'Mint Status': 'Sent' } });
        throw Object.assign(new Error('dup payment'), { code: 'DUPLICATE_PAYMENT_MINT' });
      });

    const res = await fulfilNft({ transactionId: 'cs_test_race2', email: BUYER, tier: 'retainer', provider: 'stripe' });

    expect(res).toEqual(expect.objectContaining({ minted: true, existing: true, rowId: 'mint_winner', serial: 'EMBER_005' }));
    expect(crossmintCalls(store)).toHaveLength(1);
    expect(alerted('stripe.mint_row_dropped')).toHaveLength(0);
    expect(alerted('stripe.serial_collision')).toHaveLength(1);
    expect(resendCalls(store)).toHaveLength(0);
    expect(db.createNftMint).toHaveBeenCalledTimes(2);
  });

  it('a concurrent run winning during the fresh-serial fallback insert returns its row: no drop alert, no email', async () => {
    store.crossmintStatus = 500;
    db.createNftMint
      .mockImplementationOnce(async () => { throw Object.assign(new Error('dup ref'), { code: 'DUPLICATE_REFERENCE' }); })
      .mockImplementationOnce(async () => {
        store.mints.push({ id: 'mint_winner2', fields: { 'Reference': 'EMBER_006', 'Payment Transaction ID': 'cs_test_race3', 'Mint Status': 'Failed' } });
        throw Object.assign(new Error('dup payment'), { code: 'DUPLICATE_PAYMENT_MINT' });
      });

    const res = await fulfilNft({ transactionId: 'cs_test_race3', email: BUYER, tier: 'retainer', provider: 'stripe' });

    expect(res).toEqual(expect.objectContaining({ existing: true, rowId: 'mint_winner2' }));
    expect(crossmintCalls(store)).toHaveLength(1);
    expect(alerted('stripe.mint_row_dropped')).toHaveLength(0);
    expect(resendCalls(store)).toHaveLength(0);
  });

  // Behaviour change (fix round 1): an `_r` row never minted and its PREFIX_NNN
  // belongs to another row, so the retry no longer reuses it.
  const rFallbackRow = async () => {
    store.crossmintStatus = 500;
    store.mints.push({ id: 'mint_old', fields: { 'Reference': 'EMBER_001', 'Payment Transaction ID': 'cs_test_older' } });
    db.nextSerial.mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('rpc next_serial unavailable'));
    await fulfilNft({ transactionId: 'cs_test_rfallback', email: BUYER, tier: 'retainer', provider: 'stripe' });
    const row = store.mints.find((r) => r.fields['Payment Transaction ID'] === 'cs_test_rfallback');
    expect(row.fields['Reference']).toBe('EMBER_001_rback');
    expect(row.fields['Mint Status']).toBe('Failed');
    store.crossmintStatus = 200;
    return row;
  };

  it('a retry of an _r fallback row reserves a fresh serial: Crossmint Serial, Reference and email carry it, never one another row holds', async () => {
    const row = await rFallbackRow();
    store.serials.EMBER = 1; // the counter is past EMBER_001 now

    const res = await fulfilNft({ transactionId: 'cs_test_rfallback', email: BUYER, tier: 'retainer', provider: 'retry' });

    expect(res).toEqual(expect.objectContaining({ minted: true, serial: 'EMBER_002', rowId: row.id }));
    expect(row.fields['Reference']).toBe('EMBER_002');
    expect(row.fields['Mint Status']).toBe('Sent');
    const mints = crossmintCalls(store);
    expect(mints).toHaveLength(2);
    expect(mints[1].url).toBe(mints[0].url); // same idempotency key
    const serials = mints[1].body.metadata.attributes.filter((a) => a.trait_type === 'Serial');
    expect(serials).toEqual([{ trait_type: 'Serial', value: 'EMBER_002' }]);
    const email = resendCalls(store).at(-1).body;
    expect(email.subject).toMatch(/#002/);
    expect(email.html).toContain('EMBER_002');
    expect(email.html).not.toContain('EMBER_001');
    // Only mint_old holds EMBER_001.
    expect(store.mints.filter((r) => serialFromReference(r.fields['Reference'], 'EMBER') === 'EMBER_001')).toHaveLength(1);
  });

  it('a retry of an _r row whose fresh serial collides on claim keeps the old reference and mints with no serial', async () => {
    const row = await rFallbackRow(); // counter still at 0 → the fresh reservation is EMBER_001 again

    const res = await fulfilNft({ transactionId: 'cs_test_rfallback', email: BUYER, tier: 'retainer', provider: 'retry' });

    expect(res).toEqual(expect.objectContaining({ minted: true, serial: null, rowId: row.id }));
    expect(row.fields['Reference']).toBe('EMBER_001_rback');
    const mints = crossmintCalls(store);
    expect(mints[1].body.metadata.attributes.filter((a) => a.trait_type === 'Serial')).toEqual([{ trait_type: 'Serial', value: '' }]);
    expect(resendCalls(store).at(-1).body.html).not.toContain('EMBER_001');
    expect(alerted('retry.serial_collision')).toHaveLength(1);
  });

  it('a retry of an _r row mints with no serial when the fresh reservation fails', async () => {
    const row = await rFallbackRow();
    store.serialFails = true;

    const res = await fulfilNft({ transactionId: 'cs_test_rfallback', email: BUYER, tier: 'retainer', provider: 'retry' });

    expect(res).toEqual(expect.objectContaining({ minted: true, serial: null }));
    expect(row.fields['Reference']).toBe('EMBER_001_rback');
    expect(crossmintCalls(store)[1].body.metadata.attributes.filter((a) => a.trait_type === 'Serial')).toEqual([{ trait_type: 'Serial', value: '' }]);
    expect(alerted('retry.serial_failed')).toHaveLength(1);
  });

  it('a retry of a MINT_ fallback row emails no serial (never the fallback reference), and a failed retry emails nothing', async () => {
    store.serialFails = true;
    store.crossmintStatus = 500;
    await fulfilNft({ transactionId: 'cs_test_mintref1', email: BUYER, tier: 'retainer', provider: 'stripe' });
    expect(store.mints[0].fields['Reference']).toBe('MINT_mintref1_EMBER');
    expect(resendCalls(store)).toHaveLength(1); // the first "being finalized" email

    store.serialFails = false;
    await fulfilNft({ transactionId: 'cs_test_mintref1', email: BUYER, tier: 'retainer', provider: 'retry' });
    expect(resendCalls(store)).toHaveLength(1); // failed retry: no repeat pending email
    expect(store.mints[0].fields['Retry Count']).toBe(1);

    store.crossmintStatus = 200;
    const res = await fulfilNft({ transactionId: 'cs_test_mintref1', email: BUYER, tier: 'retainer', provider: 'retry' });

    expect(res.serial).toBeNull();
    const emails = resendCalls(store);
    expect(emails).toHaveLength(2);
    expect(emails[1].body.subject).toBe('Your Aurevon Ember NFT is live — Welcome to Aurevon');
    expect(emails[1].body.html).not.toContain('MINT_');
    expect(db.nextSerial).toHaveBeenCalledTimes(1); // the retries never reserve a serial
  });

  it('a row insert failure after minting alerts *.mint_row_dropped with minted:true and still emails', async () => {
    db.createNftMint.mockRejectedValueOnce(new Error('Supabase 503'));
    const res = await fulfilNft({ transactionId: 'PPDROPPED01', email: BUYER, tier: 'retainer', provider: 'paypal' });

    expect(res).toEqual(expect.objectContaining({ minted: true, rowId: null }));
    expect(alerted('paypal.mint_row_dropped')).toEqual([
      ['paypal.mint_row_dropped', expect.objectContaining({ transactionId: 'PPDROPPED01', minted: true })],
    ]);
    expect(resendCalls(store)).toHaveLength(1);
  });

  it('a no-NFT tier returns no_nft without touching anything', async () => {
    for (const tier of ['bogo', 're_bogo', 'single', 're_single', 'deal', 'addon_rush', 'addon_whitelabel', 'unknown']) {
      await expect(fulfilNft({ transactionId: `cs_test_${tier.replace(/_/g, '')}`, email: BUYER, tier, provider: 'stripe' }))
        .resolves.toEqual({ minted: false, reason: 'no_nft' });
    }
    expect(store.calls).toHaveLength(0);
    expect(db.findMintByPaymentId).not.toHaveBeenCalled();
    expect(db.nextSerial).not.toHaveBeenCalled();
  });
});

describe('Crossmint retry key (final fix 3)', () => {
  const nftUrls = () => crossmintCalls(store).map((c) => c.url.replace(/^.*\/nfts\//, ''));

  it('a webhook-reported failure makes the next retry PUT <txn>-r1, then -r2', async () => {
    const { settleMintFailed } = await import('../../webhooks/crossmint.js');
    await fulfilNft({ transactionId: 'cs_test_whfail', email: BUYER, tier: 'retainer', provider: 'stripe' });
    const row = store.mints[0];
    expect(row.fields['Mint Status']).toBe('Sent');

    await settleMintFailed(row, { actionId: row.fields['Crossmint Action ID'], data: { error: { message: 'out of gas' } } });
    expect(row.fields).toEqual(expect.objectContaining({ 'Mint Status': 'Failed', 'Mint Key Suffix': 1 }));

    await fulfilNft({ transactionId: 'cs_test_whfail', email: BUYER, tier: 'retainer', provider: 'retry' });
    await settleMintFailed(row, { actionId: row.fields['Crossmint Action ID'], data: { error: { message: 'again' } } });
    await fulfilNft({ transactionId: 'cs_test_whfail', email: BUYER, tier: 'retainer', provider: 'retry' });

    expect(nftUrls()).toEqual(['cs_test_whfail', 'cs_test_whfail-r1', 'cs_test_whfail-r2']);
    expect(row.fields['Mint Status']).toBe('Sent');
    expect(store.mints).toHaveLength(1);
  });

  it('a synchronous HTTP failure keeps the same key (that PUT may have landed)', async () => {
    store.crossmintStatus = 500;
    await fulfilNft({ transactionId: 'cs_test_syncfail', email: BUYER, tier: 'retainer', provider: 'stripe' });
    await fulfilNft({ transactionId: 'cs_test_syncfail', email: BUYER, tier: 'retainer', provider: 'retry' });
    store.crossmintStatus = 200;
    await fulfilNft({ transactionId: 'cs_test_syncfail', email: BUYER, tier: 'retainer', provider: 'retry' });

    expect(nftUrls()).toEqual(['cs_test_syncfail', 'cs_test_syncfail', 'cs_test_syncfail']);
    expect(store.mints[0].fields['Mint Key Suffix']).toBeUndefined();
  });
});

describe('mintIdempotencyKey', () => {
  it('is the payment id for null / 0 / junk, else <txn>-r<n>', async () => {
    const { mintIdempotencyKey } = await import('../fulfil.js');
    expect(mintIdempotencyKey('PP1', null)).toBe('PP1');
    expect(mintIdempotencyKey('PP1', 0)).toBe('PP1');
    expect(mintIdempotencyKey('PP1', 'x')).toBe('PP1');
    expect(mintIdempotencyKey('PP1', 3)).toBe('PP1-r3');
  });
});

describe('nextRetryAt', () => {
  const T = new Date('2026-11-04T00:00:00.000Z');
  const hoursAfter = (n) => (Date.parse(nextRetryAt(n, T)) - T.getTime()) / 3_600_000;
  it('is 15 min × 2^retryCount, capped at 32 h', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 20].map(hoursAfter)).toEqual([0.25, 0.5, 1, 2, 4, 8, 16, 32, 32, 32]);
  });
});

describe('serialFromReference', () => {
  it.each([
    ['EMBER_007', 'EMBER_007'],
    ['EMBER_007_dupab12', 'EMBER_007'],
    ['EMBER_007_r9xYz', null],  // never minted; EMBER_007 is another row's (fix round 1)
    ['MINT_12345678_EMBER', null],
    ['RECOVER_cs_live_X', null],
    ['INSIDER_007', null],      // another prefix
    ['EMBER_007_extra', null],
    ['', null],
    [undefined, null],
  ])('%s → %s', (ref, serial) => {
    expect(serialFromReference(ref, 'EMBER')).toBe(serial);
  });
});
