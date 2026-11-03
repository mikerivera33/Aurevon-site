/**
 * api/_lib/db.js — the Supabase data layer that replaced the Airtable client.
 *
 * Replaces airtable-base-required.test.js and airtable-formula-injection.test.js.
 * The guarantees those protected carry over:
 *   - a missing connection setting fails LOUD (no silent fallback to some other
 *     database), before any request is made;
 *   - attacker-supplied values never become query syntax. Airtable needed a
 *     formula escaper; PostgREST filters are bound values, so a quote-laden email
 *     must reach `.eq()` as a plain value (normalized, otherwise untouched).
 * Plus the new mapping contract (FIELDS / toRow / toRecord) and the
 * DUPLICATE_PAYMENT idempotency signal the webhooks rely on.
 *
 * @supabase/supabase-js is replaced by a small chainable fake that records every
 * builder call and resolves to a queued `{ data, error, count }` result.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fake = vi.hoisted(() => {
  const state = { calls: [], results: [], createArgs: [], rpcs: [] };
  const METHODS = ['select', 'insert', 'update', 'upsert', 'eq', 'in', 'like', 'lt', 'gt', 'or', 'order', 'limit', 'single'];
  function builder(table) {
    const q = { table, ops: [] };
    state.calls.push(q);
    const b = {};
    for (const m of METHODS) b[m] = (...args) => { q.ops.push([m, ...args]); return b; };
    b.then = (resolve, reject) => {
      const next = state.results.length ? state.results.shift() : { data: [], error: null };
      return Promise.resolve(next).then(resolve, reject);
    };
    return b;
  }
  return {
    state,
    createClient: (...args) => {
      state.createArgs.push(args);
      return {
        from: (table) => builder(table),
        rpc: (fn, args) => {
          state.rpcs.push([fn, args]);
          return Promise.resolve(state.results.length ? state.results.shift() : { data: null, error: null });
        },
      };
    },
  };
});

vi.mock('@supabase/supabase-js', () => ({ createClient: fake.createClient }));

import * as db from '../db.js';

const { state } = fake;
const SAVED = { ...process.env };

/** Queue the next query result(s). */
const respond = (...results) => state.results.push(...results);
/** Ops of the n-th query issued (default: the only/last one). */
const ops = (n = state.calls.length - 1) => state.calls[n].ops;
const op = (name, n) => ops(n).filter(([m]) => m === name);

beforeEach(() => {
  state.calls.length = 0;
  state.results.length = 0;
  state.createArgs.length = 0;
  state.rpcs.length = 0;
  process.env = { ...SAVED, SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test' };
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  db._resetClient();
});
afterEach(() => { process.env = { ...SAVED }; db._resetClient(); });

// ── Configuration ────────────────────────────────────────────────────────────

describe('connection settings are required (fail loud)', () => {
  it('throws a clear error naming SUPABASE_URL when it is unset — before any query', async () => {
    delete process.env.SUPABASE_URL;
    await expect(db.findPaymentByTransactionId('cs_live_x')).rejects.toThrow(/SUPABASE_URL/);
    expect(state.createArgs).toHaveLength(0);
    expect(state.calls).toHaveLength(0);
  });

  it('throws a clear error naming the secret key when neither key is set', async () => {
    delete process.env.SUPABASE_SECRET_KEY;
    await expect(db.findPaymentByTransactionId('cs_live_x')).rejects.toThrow(/SUPABASE_SECRET_KEY/);
    expect(state.createArgs).toHaveLength(0);
  });

  it('accepts the legacy SUPABASE_SERVICE_ROLE_KEY', async () => {
    delete process.env.SUPABASE_SECRET_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'legacy_srk';
    respond({ data: [], error: null });
    await expect(db.findPaymentByTransactionId('cs_live_x')).resolves.toBeNull();
    expect(state.createArgs[0][0]).toBe('https://test.supabase.co');
    expect(state.createArgs[0][1]).toBe('legacy_srk');
  });

  it('creates a server-only client (no session persistence) once and reuses it', async () => {
    respond({ data: [], error: null }, { data: [], error: null });
    await db.findPaymentByTransactionId('a');
    await db.findPaymentByTransactionId('b');
    expect(state.createArgs).toHaveLength(1);
    const [url, key, opts] = state.createArgs[0];
    expect(url).toBe('https://test.supabase.co');
    expect(key).toBe('sb_secret_test');
    expect(opts.auth).toMatchObject({ persistSession: false, autoRefreshToken: false });
  });

  it('dbConfigured reflects the env (URL and a key both required)', () => {
    expect(db.dbConfigured()).toBe(true);
    delete process.env.SUPABASE_SECRET_KEY;
    expect(db.dbConfigured()).toBe(false);
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'legacy';
    expect(db.dbConfigured()).toBe(true);
    delete process.env.SUPABASE_URL;
    expect(db.dbConfigured()).toBe(false);
  });
});

// ── Mapping ──────────────────────────────────────────────────────────────────

describe('toRow', () => {
  it('maps display names to columns', () => {
    expect(db.toRow('nft_mints', { 'Mint Status': 'Sent', 'NFT Type': 'Aurevon Ember', 'Token ID': 'act_1' }))
      .toEqual({ mint_status: 'Sent', nft_type: 'Aurevon Ember', token_id: 'act_1' });
  });

  it('throws on an unknown field name (fail loud, like Airtable 422)', () => {
    expect(() => db.toRow('customer_auth', { 'Magic Link Token': 'x' })).toThrow(/Unknown field "Magic Link Token" for table customer_auth/);
    expect(() => db.toRow('payments', { Email: 'a@b.co' })).toThrow(/Unknown field "Email"/); // Payments uses Customer Email
  });

  it('lowercases and trims email columns', () => {
    expect(db.toRow('members', { Email: '  Buyer@Example.COM ' })).toEqual({ email: 'buyer@example.com' });
    expect(db.toRow('payments', { 'Customer Email': 'Buyer@Example.com' })).toEqual({ customer_email: 'buyer@example.com' });
  });

  it("turns '' into null for timestamp, boolean and numeric columns", () => {
    expect(db.toRow('customer_auth', { 'Token Expires': '', 'Session Active': '', 'Last Login': '' }))
      .toEqual({ token_expires: null, session_active: null, last_login: null });
    expect(db.toRow('payments', { Amount: '', 'Payment Date': '' })).toEqual({ amount: null, payment_date: null });
    expect(db.toRow('nft_mints', { 'Retry Count': '', 'Email Delivered': '', 'Discord Synced': '', 'Mint Date': '' }))
      .toEqual({ retry_count: null, email_delivered: null, discord_synced: null, mint_date: null });
    expect(db.toRow('leads', { 'Purchase Price': '' })).toEqual({ purchase_price: null });
  });

  it("keeps '' for text columns and keeps false / 0", () => {
    expect(db.toRow('customer_auth', { 'Magic Token': '', 'Session Active': false }))
      .toEqual({ magic_token: '', session_active: false });
    expect(db.toRow('nft_mints', { Notes: '', 'Retry Count': 0 })).toEqual({ notes: '', retry_count: 0 });
  });

  it('skips undefined values', () => {
    expect(db.toRow('members', { 'Discord ID': undefined, 'Discord Username': 'u' })).toEqual({ discord_username: 'u' });
  });
});

describe('toRecord', () => {
  it('returns the Airtable shape { id, fields } with display names and omits nulls', () => {
    const rec = db.toRecord('payments', {
      id: 'uuid-1', transaction_id: 'cs_1', customer_email: 'a@b.co', amount: '250.00',
      status: null, delivery_notes: null, created_at: '2026-11-03T00:00:00Z', airtable_id: 'recX',
    });
    expect(rec).toEqual({
      id: 'uuid-1',
      fields: { 'Transaction ID': 'cs_1', 'Customer Email': 'a@b.co', Amount: 250, 'Created At': '2026-11-03T00:00:00Z' },
    });
    expect(rec.fields).not.toHaveProperty('Status');
    expect(rec.fields).not.toHaveProperty('airtable_id');
  });

  it('keeps false booleans (e.g. Discord Synced) and returns null for no row', () => {
    expect(db.toRecord('nft_mints', { id: 'm', discord_synced: false }).fields).toEqual({ 'Discord Synced': false });
    expect(db.toRecord('nft_mints', null)).toBeNull();
  });
});

// ── Queries ──────────────────────────────────────────────────────────────────

describe('queries are parameterized (no formula / filter injection)', () => {
  it('a quote-laden email is passed as a bound eq() value, normalized but otherwise verbatim', async () => {
    const evil = `A"),OR(1,1),("@x.co' or 1=1--`;
    respond({ data: [], error: null });
    await db.findMemberByEmail(evil);
    expect(state.calls[0].table).toBe('members');
    expect(op('eq')).toEqual([['eq', 'email', evil.toLowerCase()]]);
  });

  it('findActiveMintByEmail filters by email + active statuses, newest first', async () => {
    respond({ data: [{ id: 'm1', email: 'a@b.co', mint_status: 'Sent' }], error: null });
    const rec = await db.findActiveMintByEmail(' A@B.co');
    expect(rec).toEqual({ id: 'm1', fields: { Email: 'a@b.co', 'Mint Status': 'Sent' } });
    expect(op('eq')).toEqual([['eq', 'email', 'a@b.co']]);
    expect(op('in')).toEqual([['in', 'mint_status', ['Minted', 'Sent', 'Queued']]]);
    expect(op('order')[0]).toEqual(['order', 'created_at', { ascending: false }]);
    expect(op('limit')).toEqual([['limit', 1]]);
  });

  it('listPaymentsByEmail filters Payments on customer_email (not email)', async () => {
    respond({ data: [{ id: 'p1', customer_email: 'addon@example.com', pass_type: '12-Hour Rush' }], error: null });
    const rows = await db.listPaymentsByEmail('Addon@Example.com', 1);
    expect(state.calls[0].table).toBe('payments');
    expect(op('eq')).toEqual([['eq', 'customer_email', 'addon@example.com']]);
    expect(op('limit')).toEqual([['limit', 1]]);
    expect(rows).toEqual([{ id: 'p1', fields: { 'Customer Email': 'addon@example.com', 'Pass Type': '12-Hour Rush' } }]);
  });

  it('listMintsByEmail filters NFT mints on email', async () => {
    respond({ data: [], error: null });
    await expect(db.listMintsByEmail('A@B.co')).resolves.toEqual([]);
    expect(state.calls[0].table).toBe('nft_mints');
    expect(op('eq')).toEqual([['eq', 'email', 'a@b.co']]);
  });

  it('findMintByTokenId returns null without querying for an empty token id', async () => {
    await expect(db.findMintByTokenId('')).resolves.toBeNull();
    expect(state.calls).toHaveLength(0);
  });

  it('listUnlinkedMintsBefore: Minted/Sent, not Discord-synced, minted before the cutoff', async () => {
    respond({ data: [], error: null });
    await db.listUnlinkedMintsBefore('2026-10-27T00:00:00.000Z', { maxRecords: 7 });
    expect(op('in')).toEqual([['in', 'mint_status', ['Minted', 'Sent']]]);
    expect(op('eq')).toEqual([['eq', 'discord_synced', false]]);
    expect(op('lt')).toEqual([['lt', 'mint_date', '2026-10-27T00:00:00.000Z']]);
    expect(op('limit')).toEqual([['limit', 7]]);
  });

  it('a Supabase error is thrown (never read as "no rows"), keeping the Postgres code', async () => {
    respond({ data: null, error: { message: 'permission denied for table payments', code: '42501' } });
    const err = await db.findPaymentByTransactionId('cs_1').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/permission denied/);
    expect(err.code).toBe('42501');
  });
});

describe('createPayment (webhook idempotency marker)', () => {
  const args = {
    transactionId: 'cs_live_1', method: 'Stripe Card', tier: 'full', amount: 250,
    customerEmail: 'Buyer@Example.com', customerName: 'Buyer', status: 'Succeeded', token: 'tok',
  };

  it('inserts the mapped row and returns the record', async () => {
    respond({ data: { id: 'p1', transaction_id: 'cs_live_1', customer_email: 'buyer@example.com' }, error: null });
    const rec = await db.createPayment(args);
    expect(rec).toEqual({ id: 'p1', fields: { 'Transaction ID': 'cs_live_1', 'Customer Email': 'buyer@example.com' } });
    const [[, row]] = op('insert');
    expect(row).toMatchObject({
      transaction_id: 'cs_live_1', payment_provider: 'Stripe Card', pass_type: 'full', amount: 250,
      customer_email: 'buyer@example.com', customer_name: 'Buyer', status: 'Succeeded', token: 'tok',
    });
    expect(Number.isNaN(Date.parse(row.payment_date))).toBe(false);
    expect(op('single')).toHaveLength(1);
  });

  it("maps a Postgres unique violation (23505) to err.code = 'DUPLICATE_PAYMENT'", async () => {
    respond({ data: null, error: { message: 'duplicate key value violates unique constraint "payments_transaction_id_key"', code: '23505' } });
    const err = await db.createPayment(args).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('DUPLICATE_PAYMENT');
  });

  it('leaves any other error code untouched (so the webhook alerts)', async () => {
    respond({ data: null, error: { message: 'null value in column "transaction_id"', code: '23502' } });
    const err = await db.createPayment(args).catch((e) => e);
    expect(err.code).toBe('23502');
  });
});

describe('updatePaymentStatus (refund / dispute)', () => {
  it('updates status by transaction_id and returns the record', async () => {
    respond({ data: [{ id: 'p1', transaction_id: 'cs_live_1', status: 'Refunded' }], error: null });
    const rec = await db.updatePaymentStatus('cs_live_1', 'Refunded');
    expect(rec).toEqual({ id: 'p1', fields: { 'Transaction ID': 'cs_live_1', 'Status': 'Refunded' } });
    expect(state.calls.at(-1).table).toBe('payments');
    expect(op('update')).toEqual([['update', { status: 'Refunded' }]]);
    expect(op('eq')).toEqual([['eq', 'transaction_id', 'cs_live_1']]);
  });

  it('returns null when no Payments row has that transaction id', async () => {
    respond({ data: [], error: null });
    expect(await db.updatePaymentStatus('cs_missing', 'Disputed')).toBeNull();
  });

  it('throws on a database error', async () => {
    respond({ data: null, error: { message: 'boom', code: 'XX000' } });
    await expect(db.updatePaymentStatus('cs_live_1', 'Refunded')).rejects.toThrow(/updatePaymentStatus/);
  });
});

describe('upsertMemberByEmail', () => {
  it('upserts on email with the normalized email, ignoring an Email field in the patch', async () => {
    respond({ data: { id: 'u1', email: 'm@example.com', billing_state: 'active' }, error: null });
    const rec = await db.upsertMemberByEmail(' M@Example.com ', { Email: 'attacker@example.com', 'Billing State': 'active' });
    expect(state.calls[0].table).toBe('members');
    const [[, row, opts]] = op('upsert');
    expect(row).toEqual({ email: 'm@example.com', billing_state: 'active' });
    expect(opts).toEqual({ onConflict: 'email' });
    expect(rec).toEqual({ id: 'u1', fields: { Email: 'm@example.com', 'Billing State': 'active' } });
  });

  it('rejects an unknown member field before any query', async () => {
    await expect(db.upsertMemberByEmail('m@example.com', { 'Member Teir': 'x' })).rejects.toThrow(/Unknown field/);
    expect(state.calls).toHaveLength(0);
  });
});

describe('countNftMintsByPrefix', () => {
  it("counts with a LIKE on `PREFIX\\_%` (escaped underscore), head-only", async () => {
    respond({ data: null, error: null, count: 6 });
    await expect(db.countNftMintsByPrefix('EMB')).resolves.toBe(6);
    expect(state.calls[0].table).toBe('nft_mints');
    expect(op('like')).toEqual([['like', 'reference', 'EMB\\_%']]);
    expect(op('select')).toEqual([['select', 'id', { count: 'exact', head: true }]]);
  });

  it('returns 0 for a null count and throws on error', async () => {
    respond({ data: null, error: null, count: null });
    await expect(db.countNftMintsByPrefix('INS')).resolves.toBe(0);
    respond({ data: null, error: { message: 'boom', code: 'XX000' } });
    await expect(db.countNftMintsByPrefix('INS')).rejects.toThrow(/boom/);
  });
});

describe('owner-console helpers', () => {
  it('listRecent / updateRecord refuse an unknown table before any query', async () => {
    await expect(db.listRecent('customer_auth_x')).rejects.toThrow(/Unknown table/);
    await expect(db.updateRecord('users', 'id', { Status: 'x' })).rejects.toThrow(/Unknown table/);
    expect(state.calls).toHaveLength(0);
  });

  it('updateRecord patches by id with mapped columns', async () => {
    respond({ data: { id: 'l1', status: 'Won' }, error: null });
    const rec = await db.updateRecord('leads', 'l1', { Status: 'Won' });
    expect(op('update')).toEqual([['update', { status: 'Won' }]]);
    expect(op('eq')).toEqual([['eq', 'id', 'l1']]);
    expect(rec).toEqual({ id: 'l1', fields: { Status: 'Won' } });
  });
});

// ── NFT pipeline (payment-keyed mints, atomic serials, ops events) ───────────

describe('createNftMint (mint idempotency marker)', () => {
  const args = {
    reference: 'INSIDER_007', email: 'Buyer@Example.com', nftType: 'Aurevon Insider', tierSource: 'full',
    status: 'Queued', sentDate: '2026-11-04T00:00:00Z', entitlementType: 'permanent_pass',
    paymentTransactionId: 'cs_live_1', crossmintActionId: 'act_1',
  };

  it('writes payment transaction id, Crossmint action id and entitlement type', async () => {
    respond({ data: { id: 'm1', reference: 'INSIDER_007', payment_transaction_id: 'cs_live_1' }, error: null });
    const rec = await db.createNftMint(args);
    const [[, row]] = op('insert');
    expect(row).toMatchObject({
      reference: 'INSIDER_007', email: 'buyer@example.com', payment_transaction_id: 'cs_live_1',
      crossmint_action_id: 'act_1', entitlement_type: 'permanent_pass', discord_synced: false,
    });
    expect(rec.fields['Payment Transaction ID']).toBe('cs_live_1');
  });

  it('omits payment / action columns when not given', async () => {
    respond({ data: { id: 'm1' }, error: null });
    await db.createNftMint({ ...args, paymentTransactionId: undefined, crossmintActionId: '' });
    const [[, row]] = op('insert');
    expect(row).not.toHaveProperty('payment_transaction_id');
    expect(row).not.toHaveProperty('crossmint_action_id');
  });

  it("maps 23505 on nft_mints_reference_key to 'DUPLICATE_REFERENCE'", async () => {
    respond({ data: null, error: { message: 'duplicate key value violates unique constraint "nft_mints_reference_key"', code: '23505' } });
    const err = await db.createNftMint(args).catch((e) => e);
    expect(err.code).toBe('DUPLICATE_REFERENCE');
  });

  it("maps 23505 on nft_mints_payment_txn_key to 'DUPLICATE_PAYMENT_MINT'", async () => {
    respond({ data: null, error: { message: 'duplicate key value violates unique constraint "nft_mints_payment_txn_key"', code: '23505' } });
    const err = await db.createNftMint(args).catch((e) => e);
    expect(err.code).toBe('DUPLICATE_PAYMENT_MINT');
  });

  it('leaves other errors untouched', async () => {
    respond({ data: null, error: { message: 'boom', code: '23502' } });
    const err = await db.createNftMint(args).catch((e) => e);
    expect(err.code).toBe('23502');
  });
});

describe('nextSerial', () => {
  it("calls rpc('next_serial', { p_prefix }) and returns the integer", async () => {
    respond({ data: 12, error: null });
    await expect(db.nextSerial('INSIDER')).resolves.toBe(12);
    expect(state.rpcs).toEqual([['next_serial', { p_prefix: 'INSIDER' }]]);
  });

  it('throws on an rpc error or a non-integer result', async () => {
    respond({ data: null, error: { message: 'permission denied for function next_serial', code: '42501' } });
    await expect(db.nextSerial('EMBER')).rejects.toThrow(/permission denied/);
    respond({ data: null, error: null });
    await expect(db.nextSerial('EMBER')).rejects.toThrow(/unexpected result/);
  });
});

describe('mint lookups', () => {
  it('findMintByPaymentId / findMintByActionId filter on their columns; empty id never queries', async () => {
    await expect(db.findMintByPaymentId('')).resolves.toBeNull();
    await expect(db.findMintByActionId(null)).resolves.toBeNull();
    expect(state.calls).toHaveLength(0);
    respond({ data: [{ id: 'm1', payment_transaction_id: 'txn_1' }], error: null }, { data: [], error: null });
    await expect(db.findMintByPaymentId('txn_1')).resolves.toEqual({ id: 'm1', fields: { 'Payment Transaction ID': 'txn_1' } });
    expect(op('eq', 0)).toEqual([['eq', 'payment_transaction_id', 'txn_1']]);
    await expect(db.findMintByActionId('act_9')).resolves.toBeNull();
    expect(op('eq', 1)).toEqual([['eq', 'crossmint_action_id', 'act_9']]);
  });

  it('findActiveMintByEmailAndTypeWithoutToken: active statuses, token id null or empty', async () => {
    respond({ data: [], error: null });
    await db.findActiveMintByEmailAndTypeWithoutToken('A@B.co', 'Aurevon Ember');
    expect(op('eq')).toEqual([['eq', 'email', 'a@b.co'], ['eq', 'nft_type', 'Aurevon Ember']]);
    expect(op('in')).toEqual([['in', 'mint_status', ['Minted', 'Sent', 'Queued']]]);
    expect(op('or')).toEqual([['or', 'token_id.is.null,token_id.eq.']]);
  });

  it('listActiveMintsByEmailAndTypeWithoutToken: same filters, newest first, limited list', async () => {
    respond({ data: [], error: null });
    const rows = await db.listActiveMintsByEmailAndTypeWithoutToken('A@B.co', 'Aurevon Insider');
    expect(rows).toEqual([]);
    expect(op('eq')).toEqual([['eq', 'email', 'a@b.co'], ['eq', 'nft_type', 'Aurevon Insider']]);
    expect(op('in')).toEqual([['in', 'mint_status', ['Minted', 'Sent', 'Queued']]]);
    expect(op('or')).toEqual([['or', 'token_id.is.null,token_id.eq.']]);
    expect(op('order')).toEqual([['order', 'created_at', { ascending: false }]]);
    expect(op('limit')).toEqual([['limit', 5]]);
  });

  it('listFailedMints: Failed under the retry cap, oldest first, default 10', async () => {
    respond({ data: [], error: null }, { data: [], error: null });
    await db.listFailedMints();
    expect(op('eq', 0)).toEqual([['eq', 'mint_status', 'Failed']]);
    expect(op('lt', 0)).toEqual([['lt', 'retry_count', 5]]);
    expect(op('order', 0)).toEqual([['order', 'created_at', { ascending: true }]]);
    expect(op('limit', 0)).toEqual([['limit', 10]]);
    await db.listFailedMints({ maxRecords: 50, maxRetries: 3 });
    expect(op('lt', 1)).toEqual([['lt', 'retry_count', 3]]);
    expect(op('limit', 1)).toEqual([['limit', 50]]);
  });

  it('listUndeliveredMints: Minted/Sent with email_delivered=false, oldest first', async () => {
    respond({ data: [], error: null });
    await db.listUndeliveredMints();
    expect(op('in')).toEqual([['in', 'mint_status', ['Minted', 'Sent']]]);
    expect(op('eq')).toEqual([['eq', 'email_delivered', false]]);
    expect(op('order')).toEqual([['order', 'created_at', { ascending: true }]]);
    expect(op('limit')).toEqual([['limit', 20]]);
  });
});

describe('ops health counts', () => {
  it('countMints filters by status and age (head-only count)', async () => {
    respond({ data: null, error: null, count: 3 });
    await expect(db.countMints({ status: 'Queued', olderThanMinutes: 30 })).resolves.toBe(3);
    expect(op('select')).toEqual([['select', '*', { count: 'exact', head: true }]]);
    expect(op('eq')).toEqual([['eq', 'mint_status', 'Queued']]);
    const [[, col, iso]] = op('lt');
    expect(col).toBe('updated_at');
    expect(Date.now() - Date.parse(iso)).toBeGreaterThanOrEqual(30 * 60_000 - 1000);
  });

  it('countPendingDiscordSyncOlderThan and countUndeliveredEmails', async () => {
    respond({ data: null, error: null, count: 2 }, { data: null, error: null, count: null });
    await expect(db.countPendingDiscordSyncOlderThan(6)).resolves.toBe(2);
    expect(state.calls[0].table).toBe('members');
    expect(op('eq', 0)).toEqual([['eq', 'discord_sync_status', 'pending']]);
    await expect(db.countUndeliveredEmails()).resolves.toBe(0);
    expect(op('eq', 1)).toEqual([['eq', 'email_delivered', false]]);
  });

  it('a count error is thrown', async () => {
    respond({ data: null, error: { message: 'boom', code: 'XX000' } });
    await expect(db.countUndeliveredEmails()).rejects.toThrow(/boom/);
  });
});

describe('ops events', () => {
  it('recordOpsEvent inserts into ops_events', async () => {
    respond({ data: { id: 'e1', event: 'cron.retry', severity: 'warn', dedupe_key: 'k', detail: { n: 1 } }, error: null });
    const rec = await db.recordOpsEvent({ event: 'cron.retry', severity: 'warn', dedupeKey: 'k', detail: { n: 1 } });
    expect(state.calls[0].table).toBe('ops_events');
    expect(op('insert')).toEqual([['insert', { event: 'cron.retry', severity: 'warn', dedupe_key: 'k', detail: { n: 1 } }]]);
    expect(rec.fields).toEqual({ Event: 'cron.retry', Severity: 'warn', 'Dedupe Key': 'k', Detail: { n: 1 } });
  });

  it('recordOpsEvent defaults severity to info and requires an event', async () => {
    respond({ data: { id: 'e1' }, error: null });
    await db.recordOpsEvent({ event: 'x' });
    expect(op('insert')).toEqual([['insert', { event: 'x', severity: 'info' }]]);
    await expect(db.recordOpsEvent({})).rejects.toThrow(/event is required/);
  });

  it('lastOpsEvent returns the newest row (optionally by dedupe key) or null', async () => {
    respond({ data: [{ id: 'e2', event: 'alert', dedupe_key: 'k' }], error: null }, { data: [], error: null });
    await expect(db.lastOpsEvent('alert', { dedupeKey: 'k' })).resolves.toEqual({ id: 'e2', fields: { Event: 'alert', 'Dedupe Key': 'k' } });
    expect(op('eq', 0)).toEqual([['eq', 'event', 'alert'], ['eq', 'dedupe_key', 'k']]);
    expect(op('order', 0)).toEqual([['order', 'created_at', { ascending: false }]]);
    expect(op('limit', 0)).toEqual([['limit', 1]]);
    await expect(db.lastOpsEvent('alert')).resolves.toBeNull();
    expect(op('eq', 1)).toEqual([['eq', 'event', 'alert']]);
  });
});
