/**
 * retry-mints cron (handleRetryMints): Failed rows go back through fulfilNft.
 *
 * Dedupe is by PAYMENT ID (the Crossmint idempotency key and the UNIQUE mint
 * row per payment) — never by email + NFT type, since one buyer may own two
 * passes of a type. A re-run never double-mints or double-emails.
 *
 * Behaviour change (Task 7): the old cron skipped a Failed row whenever ANY
 * active mint of the same type existed for the email, and minted with
 * mintToEmail directly. It now calls fulfilNft (stored serial, same key,
 * Retry Count / Last Error, minted email + Email Delivered); the email+type
 * case is replaced by the payment-id cases below. The idempotency-key cases
 * (RECOVER_ / PAY_ / Payments lookup / serial fallback) are unchanged.
 *
 * db: the in-memory harness (real UNIQUE semantics); Crossmint, email and
 * alerts mocked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = vi.hoisted(() => ({}));

vi.mock('../db.js', async () => (await import('./helpers/nft-harness.js')).makeFakeDb(store));
vi.mock('../airtable-import.js', () => ({ importHasProblems: vi.fn(() => false), airtableImportEnabled: vi.fn(() => false), importFromAirtable: vi.fn(), countAirtableMintsByPrefix: vi.fn() }));
vi.mock('../crossmint.js', () => ({ mintToEmail: vi.fn() }));
vi.mock('../email.js', () => ({ sendNftDelivery: vi.fn().mockResolvedValue({ ok: true }), sendDiscordAccessLink: vi.fn() }));
vi.mock('../alert.js', () => ({ sendAlert: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('../discord-bot.js', () => ({ addRoleToMember: vi.fn(), removeRoleFromMember: vi.fn() }));
vi.mock('../engage.js', () => ({ onDiscordLinkReminder: vi.fn(), onSubscriptionCancelled: vi.fn() }));

import { handleRetryMints } from '../../member/claim.js';
import { resetStore } from './helpers/nft-harness.js';
import * as db from '../db.js';
import * as crossmint from '../crossmint.js';
import { sendNftDelivery } from '../email.js';
import { sendAlert } from '../alert.js';

let seq = 0;
const nextAction = () => ({ ok: true, actionId: `act_${++seq}` });

function failedRow(id, fields) {
  const rec = { id, fields: { 'Mint Status': 'Failed', 'Retry Count': 0, 'Email Delivered': false, ...fields } };
  store.mints.push(rec);
  return rec;
}
function payment(txn, fields = {}) {
  store.payments.set(txn, { id: `pay_${txn}`, fields: { 'Transaction ID': txn, 'Status': 'Succeeded', 'Customer Name': 'Ember Buyer', ...fields } });
}
const row = (id) => store.mints.find((r) => r.id === id);
const alerted = (event) => sendAlert.mock.calls.filter(([e]) => e === event);

describe('handleRetryMints', () => {
  beforeEach(() => {
    resetStore(store);
    vi.clearAllMocks();
    db.dbConfigured.mockReturnValue(true);
    crossmint.mintToEmail.mockImplementation(async () => nextAction());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('skips cleanly (no lookup, no mint) when the database is not configured', async () => {
    db.dbConfigured.mockReturnValueOnce(false);

    const report = await handleRetryMints();

    expect(report.skipped).toBe(true);
    expect(db.listFailedMints).not.toHaveBeenCalled();
    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
  });

  it('retries a Failed row once via fulfilNft: same serial + key, email once, Retry Count +1; a second run sends nothing', async () => {
    failedRow('recEmber', {
      Email: 'buyer@example.com', 'NFT Type': 'Aurevon Ember', 'Tier Source': 'retainer',
      Reference: 'EMBER_007', 'Payment Transaction ID': 'cs_live_E1',
    });
    payment('cs_live_E1');

    const first = await handleRetryMints();

    expect(crossmint.mintToEmail).toHaveBeenCalledTimes(1);
    expect(crossmint.mintToEmail).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'cs_live_E1', serial: 'EMBER_007' }));
    expect(db.listFailedMints).toHaveBeenCalledWith({ maxRecords: 10, maxRetries: 5 });
    expect(sendNftDelivery).toHaveBeenCalledTimes(1);
    expect(sendNftDelivery).toHaveBeenCalledWith(expect.objectContaining({
      status: 'minted', serial: 'EMBER_007', transactionId: 'cs_live_E1', customerName: 'Ember Buyer',
    }));
    expect(row('recEmber').fields).toEqual(expect.objectContaining({
      'Mint Status': 'Sent', 'Retry Count': 1, 'Email Delivered': true, 'Last Error': '',
    }));
    expect(store.mints).toHaveLength(1); // retried in place, no new row
    expect(db.nextSerial).not.toHaveBeenCalled();
    expect(first).toEqual(expect.objectContaining({ retried: 1, minted: 1, failed: 0, delivered: 0 }));

    const second = await handleRetryMints();

    expect(crossmint.mintToEmail).toHaveBeenCalledTimes(1);
    expect(sendNftDelivery).toHaveBeenCalledTimes(1);
    expect(second).toEqual(expect.objectContaining({ retried: 0, minted: 0, delivered: 0 }));
  });

  it('dedupes by payment id, not email + type: an active Insider for the same buyer does not block a second purchase', async () => {
    store.mints.push({ id: 'recFirstPass', fields: {
      Email: 'buyer@example.com', 'NFT Type': 'Aurevon Insider', 'Mint Status': 'Sent', 'Email Delivered': true, 'Payment Transaction ID': 'cs_live_A',
    } });
    failedRow('recSecondPass', { Email: 'buyer@example.com', 'NFT Type': 'Aurevon Insider', 'Tier Source': 'full', Reference: 'INSIDER_004', 'Payment Transaction ID': 'cs_live_B' });

    const report = await handleRetryMints();

    expect(crossmint.mintToEmail).toHaveBeenCalledTimes(1);
    expect(crossmint.mintToEmail).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'cs_live_B' }));
    expect(row('recSecondPass').fields['Mint Status']).toBe('Sent');
    expect(report.minted).toBe(1);
  });

  it('does NOT re-mint a legacy row whose payment already has another mint row (parks it, legacy_row_skipped)', async () => {
    store.mints.push({ id: 'recCanonical', fields: { 'Mint Status': 'Sent', 'Token ID': 'act_original', 'Payment Transaction ID': 'cs_live_X' } });
    failedRow('recStale', { Email: 'buyer@example.com', 'NFT Type': 'Aurevon Insider', 'Tier Source': 'full', Reference: 'RECOVER_cs_live_X' });

    const report = await handleRetryMints();

    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
    expect(sendNftDelivery).not.toHaveBeenCalled();
    expect(report.legacySkipped).toBe(1);
    expect(alerted('retry_mints.legacy_row_skipped')).toEqual([
      ['retry_mints.legacy_row_skipped', { rowId: 'recStale', transactionId: 'cs_live_X', holderId: 'recCanonical' }, expect.objectContaining({ dedupeKey: 'legacy:recStale' })],
    ]);
    // Parked off the queue (listFailedMints filters Retry Count < 5) without claiming the payment.
    expect(row('recStale').fields['Retry Count']).toBe(5);
    expect(row('recStale').fields['Payment Transaction ID']).toBeUndefined();
    await handleRetryMints();
    expect(alerted('retry_mints.legacy_row_skipped')).toHaveLength(1);
  });

  it('reuses the original payment id as the mint idempotency key for a recovered orphan (legacy row), backfilling it first', async () => {
    failedRow('recOrphan', { Email: 'buyer@example.com', 'NFT Type': 'Aurevon Insider', 'Tier Source': 'full', Reference: 'RECOVER_cs_live_ABC123' });

    await handleRetryMints();

    expect(crossmint.mintToEmail).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'cs_live_ABC123', serial: null }));
    expect(db.updateNftMint).toHaveBeenCalledWith('recOrphan', { 'Payment Transaction ID': 'cs_live_ABC123' });
    expect(db.updateNftMint.mock.invocationCallOrder[0]).toBeLessThan(crossmint.mintToEmail.mock.invocationCallOrder[0]);
    expect(row('recOrphan').fields['Mint Status']).toBe('Sent');
    expect(store.mints).toHaveLength(1);
    // Never the RECOVER_ reference as a serial in the email.
    expect(sendNftDelivery).toHaveBeenCalledWith(expect.objectContaining({ serial: null, status: 'minted' }));
  });

  it('reuses the Payments transaction id when the Failed row Reference is a serial', async () => {
    // Webhook minted with sessionId, then recorded Failed (timeout after Crossmint
    // accepted the PUT) and stored the serial as Reference. Retrying with EMB_0007
    // would mint a second on-chain asset. The Payments marker holds the real key.
    failedRow('recPlain', { Email: 'x@example.com', 'NFT Type': 'Aurevon Ember', 'Tier Source': 'retainer', Reference: 'EMB_0007' });
    db.findLatestPaymentByEmailAndTier.mockResolvedValueOnce({ id: 'pay1', fields: { 'Transaction ID': 'cs_live_ABC123', 'Pass Type': 'retainer' } });

    await handleRetryMints();

    expect(crossmint.mintToEmail).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'cs_live_ABC123' }));
  });

  it('falls back to the serial only when no matching payment exists', async () => {
    failedRow('recPlain2', { Email: 'y@example.com', 'NFT Type': 'Aurevon Ember', 'Tier Source': 'retainer', Reference: 'EMB_0008' });

    await handleRetryMints();

    expect(crossmint.mintToEmail).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'EMB_0008' }));
  });

  it('skips the row (no mint) when the Payments lookup errors, instead of falling back to the serial', async () => {
    failedRow('recOutage', { Email: 'z@example.com', 'NFT Type': 'Aurevon Ember', 'Tier Source': 'retainer', Reference: 'EMB_0009' });
    db.findLatestPaymentByEmailAndTier.mockRejectedValueOnce(new Error('Supabase 503'));

    const out = await handleRetryMints();

    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
    expect(out.skippedLookupErrors).toBe(1);
    expect(out.remaining).toBe(1);
  });

  it('skips the legacy row (no mint) when the mint-by-payment lookup errors', async () => {
    failedRow('recOutage2', { Email: 'w@example.com', 'NFT Type': 'Aurevon Ember', 'Tier Source': 'retainer', Reference: 'RECOVER_cs_live_W' });
    db.findMintByPaymentId.mockRejectedValueOnce(new Error('Supabase 503'));

    const out = await handleRetryMints();

    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
    expect(out.skippedLookupErrors).toBe(1);
    expect(row('recOutage2').fields['Payment Transaction ID']).toBeUndefined();
  });

  it('strips a PAY_ prefix so Failed webhook rows reuse the payment id', async () => {
    failedRow('recPay', { Email: 'z@example.com', 'NFT Type': 'Aurevon Insider', 'Tier Source': 'full', Reference: 'PAY_cs_live_PAY1' });

    await handleRetryMints();

    expect(crossmint.mintToEmail).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'cs_live_PAY1' }));
    expect(db.findLatestPaymentByEmailAndTier).not.toHaveBeenCalled();
  });

  it('does NOT stamp a row Sent when the retry mint returns ok:false; counts it, writes Last Error, no repeat email', async () => {
    failedRow('recFailed3', { Email: 'fail@example.com', 'NFT Type': 'Aurevon Ember', 'Tier Source': 'retainer', 'Payment Transaction ID': 'cs_live_F3' });
    crossmint.mintToEmail.mockResolvedValueOnce({ ok: false, error: 'Crossmint 500' });

    const report = await handleRetryMints();

    expect(report).toEqual(expect.objectContaining({ retried: 1, minted: 0, failed: 1, errors: 1, remaining: 1 }));
    expect(row('recFailed3').fields).toEqual(expect.objectContaining({
      'Mint Status': 'Failed', 'Retry Count': 1, 'Last Error': expect.stringMatching(/Crossmint 500/),
    }));
    expect(sendNftDelivery).not.toHaveBeenCalled();
    expect(alerted('retry_mints.errors')).toHaveLength(1);
  });

  it('a retry that reaches 5 alerts retry_mints.gave_up and leaves the queue', async () => {
    failedRow('recTired', { Email: 'tired@example.com', 'NFT Type': 'Aurevon Ember', 'Tier Source': 'retainer', 'Retry Count': 4, 'Payment Transaction ID': 'cs_live_T' });
    crossmint.mintToEmail.mockResolvedValue({ ok: false, error: 'Crossmint 500' });

    const report = await handleRetryMints();

    expect(report).toEqual(expect.objectContaining({ failed: 1, gaveUp: 1, remaining: 0 }));
    expect(row('recTired').fields['Retry Count']).toBe(5);
    expect(alerted('retry_mints.gave_up')).toEqual([
      ['retry_mints.gave_up', expect.objectContaining({ rowId: 'recTired' }), expect.objectContaining({ dedupeKey: 'gave_up:recTired' })],
    ]);

    await handleRetryMints();
    expect(crossmint.mintToEmail).toHaveBeenCalledTimes(1); // not listed again
  });

  it('skips a row already at 5 retries (if one is listed) and alerts gave_up', async () => {
    db.listFailedMints.mockResolvedValueOnce([
      { id: 'recCapped', fields: { Email: 'c@example.com', 'NFT Type': 'Aurevon Ember', 'Tier Source': 'retainer', 'Mint Status': 'Failed', 'Retry Count': 5, 'Payment Transaction ID': 'cs_live_C' } },
    ]);

    const report = await handleRetryMints();

    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
    expect(report).toEqual(expect.objectContaining({ retried: 0, gaveUp: 1 }));
    expect(alerted('retry_mints.gave_up')).toEqual([['retry_mints.gave_up', expect.objectContaining({ rowId: 'recCapped' }), expect.anything()]]);
  });

  it('never retries a row whose payment was refunded or disputed — revokes it instead', async () => {
    failedRow('recRefunded', { Email: 'r@example.com', 'NFT Type': 'Aurevon Ember', 'Tier Source': 'retainer', 'Payment Transaction ID': 'cs_live_R' });
    payment('cs_live_R', { Status: 'Refunded' });

    const report = await handleRetryMints();

    expect(crossmint.mintToEmail).not.toHaveBeenCalled();
    expect(sendNftDelivery).not.toHaveBeenCalled();
    expect(report.reversed).toBe(1);
    expect(row('recRefunded').fields['Mint Status']).toBe('Revoked');
  });

  it('mints an older row with an unmapped Tier Source as the tier of its NFT Type', async () => {
    failedRow('recUnknownTier', { Email: 'u@example.com', 'NFT Type': 'Aurevon Ember', 'Tier Source': 'unknown', 'Payment Transaction ID': 'cs_live_U' });

    await handleRetryMints();

    expect(crossmint.mintToEmail).toHaveBeenCalledWith(expect.objectContaining({ nftType: 'Aurevon Ember', entitlementKey: 'product_b_reward' }));
  });

  describe('undelivered emails', () => {
    const sentRow = (id, fields) => store.mints.push({ id, fields: {
      'Mint Status': 'Sent', 'Email Delivered': false, Email: `${id}@example.com`, 'NFT Type': 'Aurevon Ember', 'Tier Source': 'retainer',
      'Crossmint Action ID': `act_${id}`, ...fields,
    } });

    it('re-sends the minted email once and sets Email Delivered; a second run sends nothing', async () => {
      sentRow('recQuiet', { Reference: 'EMBER_003', 'Payment Transaction ID': 'cs_live_Q' });
      payment('cs_live_Q', { 'Customer Name': 'Quiet Buyer' });

      const first = await handleRetryMints();

      expect(sendNftDelivery).toHaveBeenCalledTimes(1);
      expect(sendNftDelivery).toHaveBeenCalledWith(expect.objectContaining({
        email: 'recQuiet@example.com', status: 'minted', transactionId: 'cs_live_Q', serial: 'EMBER_003',
        mintId: 'act_recQuiet', customerName: 'Quiet Buyer', nftType: 'Aurevon Ember',
      }));
      expect(row('recQuiet').fields['Email Delivered']).toBe(true);
      expect(first.delivered).toBe(1);
      expect(crossmint.mintToEmail).not.toHaveBeenCalled();

      await handleRetryMints();
      expect(sendNftDelivery).toHaveBeenCalledTimes(1);
    });

    it('skips Failed rows, legacy rows without a payment id, and rows created in the last 10 minutes', async () => {
      store.mints.push({ id: 'recFailedQuiet', fields: { 'Mint Status': 'Failed', 'Email Delivered': false, Email: 'f@example.com', 'NFT Type': 'Aurevon Ember', 'Retry Count': 5 } });
      sentRow('recLegacy', {});
      sentRow('recYoung', { 'Payment Transaction ID': 'cs_live_Y', 'Created At': new Date().toISOString() });

      const report = await handleRetryMints();

      expect(sendNftDelivery).not.toHaveBeenCalled();
      expect(report.delivered).toBe(0);
    });

    it('a send that throws alerts retry_mints.email_failed (no email address) and the next row still goes out', async () => {
      sentRow('recBounce', { 'Payment Transaction ID': 'cs_live_B1' });
      sentRow('recFine', { 'Payment Transaction ID': 'cs_live_B2' });
      sendNftDelivery.mockRejectedValueOnce(new Error('Resend 500'));

      const report = await handleRetryMints();

      expect(sendNftDelivery).toHaveBeenCalledTimes(2);
      expect(row('recBounce').fields['Email Delivered']).toBe(false);
      expect(row('recFine').fields['Email Delivered']).toBe(true);
      expect(report).toEqual(expect.objectContaining({ delivered: 1, emailFailed: 1 }));
      expect(alerted('retry_mints.email_failed')).toEqual([
        ['retry_mints.email_failed', expect.objectContaining({ rowId: 'recBounce', transactionId: 'cs_live_B1' }), expect.anything()],
      ]);
      expect(JSON.stringify(sendAlert.mock.calls)).not.toContain('@example.com');
    });
  });

  it('writes the cron.retry_mints.ok heartbeat with the run counts', async () => {
    failedRow('recHb', { Email: 'hb@example.com', 'NFT Type': 'Aurevon Ember', 'Tier Source': 'retainer', 'Payment Transaction ID': 'cs_live_HB' });

    await handleRetryMints();

    expect(db.recordOpsEvent).toHaveBeenCalledWith({
      event: 'cron.retry_mints.ok',
      severity: 'info',
      detail: { retried: 1, minted: 1, failed: 0, gaveUp: 0, delivered: 0, remaining: 0 },
    });
  });

  it('a heartbeat write failure is logged, never thrown', async () => {
    db.recordOpsEvent.mockRejectedValueOnce(new Error('Supabase 503'));

    await expect(handleRetryMints()).resolves.toEqual(expect.objectContaining({ retried: 0 }));
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/heartbeat cron\.retry_mints\.ok not recorded/));
  });

  it('never logs a recipient email', async () => {
    failedRow('recPriv', { Email: 'private.buyer@example.com', 'NFT Type': 'Aurevon Ember', 'Tier Source': 'retainer', Reference: 'RECOVER_cs_live_P' });
    crossmint.mintToEmail.mockResolvedValueOnce({ ok: false, error: 'Crossmint 500' });

    await handleRetryMints();

    const logged = JSON.stringify([...console.log.mock.calls, ...console.error.mock.calls, ...sendAlert.mock.calls]);
    expect(logged).not.toContain('private.buyer@example.com');
  });
});
