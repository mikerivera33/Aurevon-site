/**
 * Info-disclosure regression for GET /api/health (finding L1).
 *
 * The public/unauthenticated health body previously leaked a precise
 * misconfiguration map: env="partial", the exact names of any missing required
 * env vars, and the app version. That is how a missing CROSSMINT_WEBHOOK_SECRET
 * was discovered from the outside.
 *
 * Fix: unauthenticated callers get a minimal liveness body only. The full
 * diagnostic is gated behind `Authorization: Bearer <INTERNAL_API_SECRET>`
 * (timing-safe, length-guarded) and FAILS CLOSED when the secret is unset.
 *
 * The minimal body carries one extra coarse field, `database`
 * ('ok' | 'unconfigured' | 'unavailable'), and nothing else — not even when the
 * authed readiness check would answer 503 (readiness is never public).
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
import * as db from '../db.js';
import {
  SECRET, HEALTHY_ENV, applyEnv, healthyFetch, freshHeartbeats, endpointList, mockRes,
} from './helpers/health-fixtures.js';

const MINIMAL_KEYS = ['database', 'ok', 'status'];

const SAVED = { ...process.env };
beforeEach(() => {
  _resetHealthCache();
  vi.clearAllMocks();
  db.dbConfigured.mockReturnValue(true);
  db.ping.mockResolvedValue(true);
  db.countMints.mockResolvedValue(0);
  db.countPendingDiscordSyncOlderThan.mockResolvedValue(0);
  db.countUndeliveredEmails.mockResolvedValue(0);
  db.lastOpsEvent.mockImplementation(freshHeartbeats());
  stripeList.mockResolvedValue(endpointList());
  healthyFetch();
});
afterEach(() => { process.env = { ...SAVED }; vi.useRealTimers(); vi.unstubAllGlobals(); });

async function get(headers = {}) {
  const res = mockRes();
  await handler({ method: 'GET', headers, query: {} }, res);
  return res;
}

describe('GET /api/health — info disclosure (L1)', () => {
  it('unauthenticated GET returns ONLY a minimal body (no version / env / missing_required)', async () => {
    process.env.INTERNAL_API_SECRET = SECRET;
    const res = await get();

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'healthy', database: 'ok' });
    expect(Object.keys(res.body).sort()).toEqual(MINIMAL_KEYS);
    expect(res.body.version).toBeUndefined();
    expect(res.body.env).toBeUndefined();
    expect(res.body.missing_required).toBeUndefined();
    expect(res.body.function_count).toBeUndefined();
  });

  it('a wrong bearer secret still gets only the minimal body', async () => {
    process.env.INTERNAL_API_SECRET = SECRET;
    const res = await get({ authorization: 'Bearer wrong-secret' });

    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(MINIMAL_KEYS);
    expect(res.body.version).toBeUndefined();
    expect(res.body.missing_required).toBeUndefined();
  });

  it('a correct bearer secret returns the full diagnostic body', async () => {
    applyEnv(HEALTHY_ENV);
    const res = await get({ authorization: `Bearer ${SECRET}` });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('healthy');
    expect(res.body.problems).toEqual([]);
    expect(res.body.version).toBeDefined();
    expect(res.body).toHaveProperty('env');
    expect(res.body.env).toEqual({ complete: true, missing_required: [], misnamed: [] });
    expect(res.body.database).toBe('ok');
    expect(res.body.function_limit).toBe(100);
    for (const k of ['mint', 'stripe', 'email', 'discord', 'crons', 'queue', 'alerts']) expect(res.body).toHaveProperty(k);
  });

  it('the authed body never contains an env VALUE', async () => {
    applyEnv(HEALTHY_ENV);
    const res = await get({ authorization: `Bearer ${SECRET}` });
    const raw = JSON.stringify(res.body);
    for (const [k, v] of Object.entries(HEALTHY_ENV)) {
      expect(raw, k).not.toContain(v);
    }
  });

  it('public body stays exactly { ok, status, database } with HTTP 200 even when the pipeline is NOT ready', async () => {
    applyEnv({ INTERNAL_API_SECRET: SECRET }); // nearly everything missing → authed would be 503
    stripeList.mockResolvedValue(endpointList(['checkout.session.completed']));
    db.lastOpsEvent.mockResolvedValue(null);
    db.countMints.mockResolvedValue(7);

    const pub = await get();
    expect(pub.statusCode).toBe(200);
    expect(pub.body).toEqual({ ok: true, status: 'healthy', database: 'ok' });
    expect(Object.keys(pub.body).sort()).toEqual(MINIMAL_KEYS);

    const authed = await get({ authorization: `Bearer ${SECRET}` });
    expect(authed.statusCode).toBe(503);
    expect(authed.body.ok).toBe(false);
  });

  it('public requests never run the readiness probes (no Stripe / Crossmint / Discord calls)', async () => {
    applyEnv(HEALTHY_ENV);
    const fetchSpy = healthyFetch();
    await get();
    await get({ authorization: 'Bearer wrong-secret' });
    expect(stripeList).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.countMints).not.toHaveBeenCalled();
  });

  it('diagnostic: Supabase URL + a secret key are required; Airtable vars are not', async () => {
    process.env.INTERNAL_API_SECRET = SECRET;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.AIRTABLE_PAT;
    delete process.env.AIRTABLE_BASE_ID;
    let res = await get({ authorization: `Bearer ${SECRET}` });
    expect(res.body.env.complete).toBe(false);
    expect(res.body.env.missing_required).toEqual(expect.arrayContaining(['SUPABASE_URL', 'SUPABASE_SECRET_KEY']));
    expect(res.body.env.missing_required).not.toContain('AIRTABLE_PAT');
    expect(res.body.env.missing_required).not.toContain('AIRTABLE_BASE_ID');

    // The legacy service-role key satisfies the key requirement.
    process.env.SUPABASE_URL = 'https://x.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
    _resetHealthCache();
    res = await get({ authorization: `Bearer ${SECRET}` });
    expect(res.body.env.missing_required).not.toContain('SUPABASE_URL');
    expect(res.body.env.missing_required).not.toContain('SUPABASE_SECRET_KEY');
  });

  it('fails closed: when INTERNAL_API_SECRET is unset, even a bearer request gets the minimal body', async () => {
    delete process.env.INTERNAL_API_SECRET;
    const res = await get({ authorization: 'Bearer anything' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'healthy', database: 'ok' });
    expect(res.body.version).toBeUndefined();
  });

  it('a bearer with equal STRING length but different BYTE length does not throw (byte-length guard) and gets the minimal body', async () => {
    // secret is 29 chars / 29 bytes. This provided value is also 29 JS chars but
    // 30 bytes (the 'é' is 2 UTF-8 bytes) — a string-length-only guard would pass
    // it into timingSafeEqual, which throws RangeError on byte-length mismatch.
    process.env.INTERNAL_API_SECRET = SECRET;
    const res = mockRes();
    await expect(
      handler({ method: 'GET', headers: { authorization: 'Bearer health_diag_secret_012345678é' }, query: {} }, res),
    ).resolves.not.toThrow();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'healthy', database: 'ok' });
    expect(res.body.version).toBeUndefined();
  });

  it('still rejects non-GET methods with 405 (no database ping)', async () => {
    const res = mockRes();
    await handler({ method: 'POST', headers: {}, query: {} }, res);
    expect(res.statusCode).toBe(405);
    expect(db.ping).not.toHaveBeenCalled();
  });
});

describe('GET /api/health — database status', () => {
  it("reports 'unconfigured' without pinging when Supabase env is missing", async () => {
    db.dbConfigured.mockReturnValue(false);
    const res = await get();
    expect(res.body).toEqual({ ok: true, status: 'healthy', database: 'unconfigured' });
    expect(db.ping).not.toHaveBeenCalled();
  });

  it("reports 'unavailable' (still 200, no error text leaked) when the ping fails", async () => {
    db.ping.mockRejectedValueOnce(new Error('Supabase ping: relation "payments" does not exist'));
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'healthy', database: 'unavailable' });
    expect(JSON.stringify(res.body)).not.toContain('relation');
  });

  it("reports 'unavailable' within ~3s when the ping hangs", async () => {
    vi.useFakeTimers();
    db.ping.mockReturnValueOnce(new Promise(() => {}));
    const res = mockRes();
    const done = handler({ method: 'GET', headers: {}, query: {} }, res);
    await vi.advanceTimersByTimeAsync(3000);
    await done;
    expect(res.body).toEqual({ ok: true, status: 'healthy', database: 'unavailable' });
  });
});

describe('GET /api/health — database status cache', () => {
  it('pings the database at most once per 30s per instance', async () => {
    const a = await get();
    const b = await get();
    expect(a.body.database).toBe('ok');
    expect(b.body.database).toBe('ok');
    expect(db.ping).toHaveBeenCalledTimes(1);
  });
});
