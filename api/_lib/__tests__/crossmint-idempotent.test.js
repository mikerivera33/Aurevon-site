/**
 * Idempotent mint regression (double-mint High).
 *
 * The webhook mints on-chain, then writes an NFT_Mints row. If that row write
 * fails transiently, orphan-recovery → retry-mints re-invokes mintToEmail. Before
 * this fix that produced a SECOND on-chain asset. mintToEmail now mints via
 * Crossmint's idempotent PUT /collections/{id}/nfts/{key} when given a per-purchase
 * key (the payment transaction id), so the re-mint is a no-op that returns the
 * already-minted NFT instead of minting again.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mintToEmail } from '../crossmint.js';

const SAVED = { ...process.env };
let lastCall;

beforeEach(() => {
  vi.clearAllMocks();
  lastCall = null;
  process.env.CROSSMINT_API_KEY = 'ck_test_key';
  process.env.CROSSMINT_COLLECTION_ID = 'col_test';
  vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
    lastCall = { url, method: opts.method };
    return { ok: true, json: async () => ({ actionId: 'act_123', id: 'nft_1' }) };
  }));
});
afterEach(() => { process.env = { ...SAVED }; vi.unstubAllGlobals(); });

describe('mintToEmail idempotency', () => {
  it('uses idempotent PUT to /nfts/{key} when an idempotencyKey is supplied', async () => {
    const res = await mintToEmail({
      email: 'buyer@example.com', nftType: 'Aurevon Insider', customerName: 'B',
      templateKey: null, serial: 'INS_0001', collectionName: 'Aurevon', tierKey: 'full',
      idempotencyKey: 'cs_live_ABC123',
    });
    expect(res.ok).toBe(true);
    expect(lastCall.method).toBe('PUT');
    expect(lastCall.url).toMatch(/\/collections\/col_test\/nfts\/cs_live_ABC123$/);
  });

  it('sanitizes unsafe characters in the idempotency key (Crossmint path-id safety)', async () => {
    await mintToEmail({
      email: 'b@example.com', nftType: 'x', customerName: 'B',
      templateKey: null, serial: null, collectionName: 'A', tierKey: 'full',
      idempotencyKey: 'pp/txn:99 #weird',
    });
    // Only [A-Za-z0-9_-] survive; everything else becomes '-'
    expect(lastCall.method).toBe('PUT');
    expect(lastCall.url).toMatch(/\/nfts\/pp-txn-99--weird$/);
  });

  it('falls back to non-idempotent POST /nfts when no key is supplied', async () => {
    await mintToEmail({
      email: 'b@example.com', nftType: 'x', customerName: 'B',
      templateKey: null, serial: null, collectionName: 'A', tierKey: 'full',
    });
    expect(lastCall.method).toBe('POST');
    expect(lastCall.url).toMatch(/\/collections\/col_test\/nfts$/);
  });

  it('a repeat call with the same key hits the same idempotent URL (Crossmint no-ops server-side)', async () => {
    const args = {
      email: 'b@example.com', nftType: 'x', customerName: 'B',
      templateKey: null, serial: null, collectionName: 'A', tierKey: 'full',
      idempotencyKey: 'cs_live_DUP',
    };
    await mintToEmail(args);
    const first = lastCall.url;
    await mintToEmail(args);
    expect(lastCall.url).toBe(first); // identical target → Crossmint returns existing NFT, no 2nd mint
  });
});
