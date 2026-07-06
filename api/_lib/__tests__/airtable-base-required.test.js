/**
 * A missing AIRTABLE_BASE_ID must fail LOUD, not silently fall back to a hardcoded
 * dev base (the old behavior let a misconfigured deploy read/write the wrong base).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { findPaymentByTransactionId } from '../airtable.js';

const SAVED = { ...process.env };
afterEach(() => { process.env = { ...SAVED }; vi.unstubAllGlobals(); });
beforeEach(() => vi.clearAllMocks());

describe('AIRTABLE_BASE_ID is required', () => {
  it('throws a clear error (not a silent stale-base read) when unset', async () => {
    delete process.env.AIRTABLE_BASE_ID;
    process.env.AIRTABLE_PAT = 'pat_test';
    // fetch must never be reached — getBase() throws while building the URL
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(findPaymentByTransactionId('cs_live_x')).rejects.toThrow(/AIRTABLE_BASE_ID/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves normally when AIRTABLE_BASE_ID is set', async () => {
    process.env.AIRTABLE_BASE_ID = 'app_configured';
    process.env.AIRTABLE_PAT = 'pat_test';
    let calledUrl = null;
    vi.stubGlobal('fetch', vi.fn(async (url) => { calledUrl = url; return { ok: true, json: async () => ({ records: [] }) }; }));
    const res = await findPaymentByTransactionId('cs_live_x');
    expect(res).toBeNull();
    expect(calledUrl).toContain('/app_configured/');
  });
});
