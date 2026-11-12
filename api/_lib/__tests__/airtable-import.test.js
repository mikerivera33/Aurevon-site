/**
 * Airtable → Supabase bridge: value coercion, NOT NULL defaults, per-row fallback.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const upsertCalls = [];
let failBatch = false;
vi.mock('../db.js', async () => {
  const real = await vi.importActual('../db.js');
  return {
    ...real,
    supabase: () => ({
      from: (table) => ({
        upsert: (rows, opts) => ({
          select: async () => {
            upsertCalls.push({ table, rows, opts });
            if (failBatch && rows.length > 1) return { data: null, error: { message: 'batch failed' } };
            if (rows.some((r) => r.airtable_id === 'recBAD')) return { data: null, error: { message: 'bad row' } };
            return { data: rows.map((_, i) => ({ id: `id${i}` })), error: null };
          },
        }),
      }),
    }),
  };
});

import { mapAirtableRecord, importFromAirtable, importHasProblems } from '../airtable-import.js';

describe('mapAirtableRecord', () => {
  it('fills NOT NULL defaults Airtable leaves out and coerces types', () => {
    const row = mapAirtableRecord('nft_mints', {
      id: 'rec1', createdTime: '2026-01-02T03:04:05.000Z',
      fields: { 'Email': ' A@B.com ', 'Mint Status': 'Minted', 'Retry Count': '2', 'Mint Date': '2026-01-02', 'Unknown': 'x' },
    });
    expect(row).toMatchObject({
      email: 'a@b.com', mint_status: 'Minted', retry_count: 2, email_delivered: false, discord_synced: false,
      airtable_id: 'rec1', created_at: '2026-01-02T03:04:05.000Z',
    });
    expect(row.mint_date).toBe('2026-01-02T00:00:00.000Z');
    expect(row).not.toHaveProperty('Unknown');
  });

  it('parks a Failed mint that reached the old 5-retry cap at 8 so retry-mints never resurrects it', () => {
    const mint = (status, count) => mapAirtableRecord('nft_mints', {
      id: `rec_${status}_${count}`, fields: { 'Email': 'a@b.com', 'Mint Status': status, 'Retry Count': count },
    }).retry_count;
    expect(mint('Failed', 5)).toBe(8);
    expect(mint('Failed', 7)).toBe(8);
    expect(mint('Failed', '6')).toBe(8);
    expect(mint('Failed', 9)).toBe(8);
    expect(mint('Failed', 4)).toBe(4);   // still retryable
    expect(mint('Failed', undefined)).toBe(0);
    expect(mint('Sent', 5)).toBe(5);     // only Failed rows are parked
  });

  it('drops values that do not fit the column instead of failing the batch', () => {
    const row = mapAirtableRecord('leads', { id: 'rec2', fields: { 'Name': 'X', 'Purchase Price': 'about 1.2M' } });
    expect(row.purchase_price).toBeUndefined();
    expect(row.status).toBe('New');
  });
});

describe('importFromAirtable', () => {
  beforeEach(() => {
    upsertCalls.length = 0;
    failBatch = false;
    process.env.AIRTABLE_PAT = 'pat_test';
    process.env.AIRTABLE_BASE_ID = 'appTEST';
    globalThis.fetch = vi.fn(async (url) => {
      const isMints = String(url).includes('tbliXEGJdoEIAJU06');
      const records = isMints
        ? [{ id: 'recOK', fields: { 'Email': 'a@b.com', 'Reference': 'INSIDER_001' } },
           { id: 'recBAD', fields: { 'Email': 'c@d.com', 'Reference': 'INSIDER_002' } }]
        : [];
      return { ok: true, status: 200, json: async () => ({ records }), text: async () => "" };
    });
  });

  it('never nulls columns it did not send', async () => {
    await importFromAirtable();
    expect(upsertCalls.every((c) => c.opts.defaultToNull === false && c.opts.ignoreDuplicates === true)).toBe(true);
  });

  it('retries row by row when a batch fails and reports the bad rows', async () => {
    failBatch = true;
    const report = await importFromAirtable();
    expect(report.nft_mints).toMatchObject({ read: 2, written: 1, failed: 1 });
    expect(report.nft_mints.errors[0]).toContain('recBAD');
    expect(importHasProblems(report)).toBe(true);
  });
});
