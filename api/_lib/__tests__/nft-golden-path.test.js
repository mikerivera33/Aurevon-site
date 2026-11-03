/**
 * NFT golden path: every one of the five NFTs, through every way it can be
 * bought (Stripe webhook, PayPal IPN, direct-mint endpoint), lands as exactly
 * one Crossmint mint, one NFT_Mints row and one delivery email whose Discord
 * link resolves to the buyer — and a redelivery changes nothing.
 *
 * tiers.js / entitlements.js / crossmint.js / email.js / fulfil.js / discord.js
 * are REAL. Only the database, alerts, the Discord bot, the Stripe SDK and the
 * network (fetch) are faked.
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

import {
  resetStore, applyEnv, installFetch, crossmintCalls, resendCalls,
  NFT_CASES, deliver, txnId, providerTier, ENV,
} from './helpers/nft-harness.js';

const SAVED = { ...process.env };
let db;
let sendAlert;
let verifyDiscordAccessToken;
let fulfilNft;

beforeAll(async () => {
  applyEnv(); // before the first import of crossmint.js (it reads CROSSMINT_ENV at load)
  db = await import('../db.js');
  ({ sendAlert } = await import('../alert.js'));
  ({ verifyDiscordAccessToken } = await import('../../discord.js'));
  ({ fulfilNft } = await import('../fulfil.js'));
});
afterAll(() => { process.env = { ...SAVED }; vi.unstubAllGlobals(); });

beforeEach(() => {
  resetStore(store);
  applyEnv();
  vi.clearAllMocks();
  installFetch(store);
});

const BUYER = 'Gold.Buyer@Example.com';
const buyer = BUYER.toLowerCase();

function discordTokenFrom(html) {
  const m = html.match(/\/api\/discord\?action=auth&token=([^"&\s<]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

describe.each(['stripe', 'paypal', 'manual'])('%s golden path', (provider) => {
  describe.each(NFT_CASES)('%s', (nftType, entitlementKey, prefix, checkoutKey, canonicalKey, amount) => {
    it('one payment row, one mint, one row, one email with a working Discord link; redelivery is a no-op', async () => {
      const id = txnId(provider, `gold${prefix}1`);
      const tier = providerTier(provider, checkoutKey, canonicalKey);

      const res = await deliver[provider]({ id, tier, amount, email: BUYER });

      // Payments marker — webhooks only (the manual endpoint takes no money).
      if (provider === 'manual') {
        expect(db.createPayment).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ ok: true, minted: true, nftType, serial: `${prefix}_001` });
      } else {
        expect(db.createPayment).toHaveBeenCalledTimes(1);
        expect(db.createPayment).toHaveBeenCalledWith(expect.objectContaining({ transactionId: id, tier, status: 'Succeeded' }));
      }

      // Exactly one documented, idempotent Crossmint PUT keyed on the payment.
      const mints = crossmintCalls(store);
      expect(mints).toHaveLength(1);
      expect(mints[0].method).toBe('PUT');
      expect(mints[0].url).toBe(`https://www.crossmint.com/api/2022-06-09/collections/col_test/nfts/${id}`);
      expect(mints[0].body.recipient).toBe(`email:${buyer}:base`);
      expect(mints[0].body.metadata.attributes).toEqual(expect.arrayContaining([
        { trait_type: 'Tier', value: nftType },
        { trait_type: 'Serial', value: `${prefix}_001` },
      ]));
      expect(JSON.stringify(mints[0].body.metadata).toLowerCase()).not.toContain(buyer);

      // One NFT_Mints row tied to the payment, canonical tier, status Sent.
      expect(db.createNftMint).toHaveBeenCalledTimes(1);
      expect(db.createNftMint).toHaveBeenCalledWith(expect.objectContaining({
        reference: `${prefix}_001`,
        email: buyer,
        nftType,
        tierSource: canonicalKey,
        status: 'Sent',
        paymentTransactionId: id,
        entitlementType: entitlementKey,
        crossmintActionId: expect.stringMatching(/^act_/),
        emailDelivered: false,
      }));

      // One delivery email whose Discord link is bound to the buyer.
      const emails = resendCalls(store);
      expect(emails).toHaveLength(1);
      expect(emails[0].body.to).toEqual([buyer]);
      expect(emails[0].body.html).toContain('/api/discord?action=auth&token=');
      const token = discordTokenFrom(emails[0].body.html);
      expect(verifyDiscordAccessToken(token).email).toBe(buyer);

      // Email Delivered flipped only after the send succeeded.
      expect(store.mints).toHaveLength(1);
      expect(store.mints[0].fields['Email Delivered']).toBe(true);
      expect(db.updateNftMint).toHaveBeenCalledWith(store.mints[0].id, { 'Email Delivered': true });

      expect(sendAlert).not.toHaveBeenCalled();

      // Second delivery of the same event: zero extra Crossmint / Resend calls.
      // (the PayPal IPN verify round-trip is the only call a redelivery may make)
      const sideEffects = () => store.calls.filter((c) => !c.url.includes('ipnpb')).length;
      const before = sideEffects();
      const again = await deliver[provider]({ id, tier, amount, email: BUYER });
      expect(sideEffects()).toBe(before);
      expect(crossmintCalls(store)).toHaveLength(1);
      expect(resendCalls(store)).toHaveLength(1);
      expect(store.mints).toHaveLength(1);
      if (provider === 'manual') expect(again.body).toEqual({ ok: true, minted: true, nftType, serial: `${prefix}_001` });
      else expect(db.createPayment).toHaveBeenCalledTimes(1);
    });
  });
});

describe('fulfilNft is idempotent on the payment id on its own', () => {
  it('a second call for the same transaction returns the existing row without any network call', async () => {
    const first = await fulfilNft({ transactionId: 'cs_test_direct1', email: BUYER, customerName: 'G B', tier: 're_full', provider: 'stripe' });
    expect(first).toEqual(expect.objectContaining({ minted: true, entitlementKey: 'product_a_reward', nftType: 'Aurevon Insider', serial: 'INSIDER_001' }));
    const calls = store.calls.length;

    const second = await fulfilNft({ transactionId: 'cs_test_direct1', email: BUYER, customerName: 'G B', tier: 're_full', provider: 'stripe' });
    expect(second).toEqual(expect.objectContaining({ minted: true, existing: true, serial: 'INSIDER_001', rowId: first.rowId }));
    expect(store.calls.length).toBe(calls);
    expect(db.nextSerial).toHaveBeenCalledTimes(1);
  });

  it('a member who already linked Discord is queued for a role re-sync', async () => {
    store.members.set(buyer, { id: 'mem1', fields: { 'Discord ID': 'd_123' } });
    await fulfilNft({ transactionId: 'PPRESYNC01', email: BUYER, tier: 'comm_lifetime', provider: 'paypal' });
    expect(db.updateDiscordSyncStatus).toHaveBeenCalledWith(buyer, 'pending');
  });

  it('throws only for programmer errors', async () => {
    await expect(fulfilNft({ email: BUYER, tier: 'full', provider: 'stripe' })).rejects.toThrow(/transactionId/);
    await expect(fulfilNft({ transactionId: 'cs_test_x1', tier: 'full', provider: 'stripe' })).rejects.toThrow(/email/);
  });
});

const NO_NFT = [
  // provider, provider-side tier, amount, intake query (null = no intake link)
  ['stripe', 're_bogo', 299.99, 'session_id'],
  ['stripe', 're_single', 189.99, 'session_id'],
  ['stripe', 'addon_rush', 99, null],
  ['paypal', 'bogo', 299.99, 'txn_id'],
  ['paypal', 'single', 189.99, 'txn_id'],
  // PayPal does not sell add-ons: a $99 IPN resolves to no eligible tier ("unknown").
  ['paypal', 'addon_rush', 99, null],
];

describe.each(NO_NFT)('%s %s (no NFT)', (provider, tier, amount, intakeParam) => {
  it('never reaches Crossmint or NFT_Mints; sends one purchase confirmation without a Discord link', async () => {
    const id = txnId(provider, `noNft${tier.replace(/_/g, '')}`);
    await deliver[provider]({ id, tier, amount, email: BUYER });

    expect(db.createPayment).toHaveBeenCalledTimes(1);
    expect(crossmintCalls(store)).toHaveLength(0);
    expect(db.createNftMint).not.toHaveBeenCalled();
    expect(db.nextSerial).not.toHaveBeenCalled();

    const emails = resendCalls(store);
    expect(emails).toHaveLength(1);
    expect(emails[0].body.html).not.toContain('action=auth');
    expect(emails[0].body.html).not.toContain(ENV.DISCORD_INVITE_URL);
    if (intakeParam) {
      expect(emails[0].body.html).toContain(`aurevon-re-intake.html?${intakeParam}=${id}`);
    } else {
      expect(emails[0].body.html).not.toContain('aurevon-re-intake');
    }
  });
});
