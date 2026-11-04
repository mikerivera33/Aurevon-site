/**
 * Shared harness for the NFT pipeline tests (golden path + failure modes).
 *
 * - makeFakeDb(store): an in-memory stand-in for ../db.js carrying EVERY name
 *   the webhook / claim / discord / fulfil modules import, with the real
 *   UNIQUE semantics (DUPLICATE_PAYMENT, DUPLICATE_PAYMENT_MINT, DUPLICATE_REFERENCE).
 * - installFetch(store): stubs fetch and routes Crossmint, Resend and the PayPal
 *   IPN verify call, recording { url, method, body } for each.
 * - deliver[provider](…): drives one payment through the real handler.
 *
 * Not a test file (no .test.js suffix); lives under api/_lib so Vercel never
 * deploys it as a function.
 */
import { vi } from 'vitest';

export function freshStore() {
  return {
    payments: new Map(),
    mints: [],
    serials: {},
    members: new Map(),
    seq: 0,
    calls: [],
    ops: [],
    crossmintStatus: 200,
    resendFails: false,
    serialFails: false,
  };
}

/** Reset a hoisted store in place (the vi.mock factory holds the reference). */
export function resetStore(store) {
  Object.assign(store, freshStore());
}

const dup = (code) => Object.assign(new Error(`duplicate key (${code})`), { code });

export function makeFakeDb(store) {
  const mintByTxn = (t) => store.mints.find((r) => r.fields['Payment Transaction ID'] === String(t)) ?? null;
  return {
    // payments
    findPaymentByTransactionId: vi.fn(async (id) => store.payments.get(id) ?? null),
    createPayment: vi.fn(async (p) => {
      if (store.payments.has(p.transactionId)) throw dup('DUPLICATE_PAYMENT');
      const rec = { id: `pay_${++store.seq}`, fields: {
        'Transaction ID': p.transactionId, 'Pass Type': p.tier, 'Status': p.status, 'Payment Provider': p.method,
        'Customer Email': p.customerEmail, 'Customer Name': p.customerName, 'Amount': p.amount,
      } };
      store.payments.set(p.transactionId, rec);
      return rec;
    }),
    updatePaymentStatus: vi.fn(async (id, status) => {
      const rec = store.payments.get(id);
      if (!rec) return null;
      rec.fields['Status'] = status;
      return rec;
    }),
    listPaymentsSince: vi.fn(async () => []),
    listPaymentTransactionIds: vi.fn(async (ids) => new Set((ids ?? []).filter((id) => store.payments.has(id)))),
    findLatestPaymentByEmailAndTier: vi.fn(async () => null),
    // serials
    nextSerial: vi.fn(async (prefix) => {
      if (store.serialFails) throw new Error('rpc next_serial unavailable');
      store.serials[prefix] = (store.serials[prefix] ?? 0) + 1;
      return store.serials[prefix];
    }),
    // nft_mints
    createNftMint: vi.fn(async (m) => {
      if (m.paymentTransactionId && mintByTxn(m.paymentTransactionId)) throw dup('DUPLICATE_PAYMENT_MINT');
      if (store.mints.some((r) => r.fields['Reference'] === m.reference)) throw dup('DUPLICATE_REFERENCE');
      const rec = {
        id: `mint_${++store.seq}`,
        fields: {
          'Reference': m.reference,
          'Email': m.email,
          'NFT Type': m.nftType,
          'Tier Source': m.tierSource,
          'Mint Status': m.status,
          'Email Delivered': m.emailDelivered,
          'Notes': m.notes,
          'Token ID': m.mintId,
          'Retry Count': m.retryCount,
          'Entitlement Type': m.entitlementType,
          'Payment Transaction ID': m.paymentTransactionId,
          'Crossmint Action ID': m.crossmintActionId,
        },
      };
      store.mints.push(rec);
      return rec;
    }),
    findMintByPaymentId: vi.fn(async (t) => mintByTxn(t)),
    updateNftMint: vi.fn(async (id, fields) => {
      const rec = store.mints.find((r) => r.id === id);
      if (!rec) throw new Error(`no mint ${id}`);
      const other = (col) => fields[col] && store.mints.some((r) => r.id !== id && r.fields[col] === fields[col]);
      if (other('Payment Transaction ID')) throw dup('DUPLICATE_PAYMENT_MINT');
      if (other('Reference')) throw dup('DUPLICATE_REFERENCE');
      Object.assign(rec.fields, fields);
      return rec;
    }),
    findMintByActionId: vi.fn(async () => null),
    findMintByTokenId: vi.fn(async () => null),
    findActiveMintByEmail: vi.fn(async () => null),
    findActiveMintsByEmail: vi.fn(async () => []),
    findActiveMintByEmailAndType: vi.fn(async () => null),
    findAnyMintByEmailAndType: vi.fn(async () => null),
    listUnlinkedMintsBefore: vi.fn(async () => []),
    listFailedMints: vi.fn(async ({ maxRecords = 10, maxRetries = 5 } = {}) => store.mints
      .filter((r) => r.fields['Mint Status'] === 'Failed' && Number(r.fields['Retry Count'] ?? 0) < maxRetries)
      .slice(0, maxRecords)),
    listUndeliveredMints: vi.fn(async ({ maxRecords = 20 } = {}) => store.mints
      .filter((r) => ['Minted', 'Sent'].includes(r.fields['Mint Status']) && r.fields['Email Delivered'] !== true)
      .slice(0, maxRecords)),
    // ops_events
    recordOpsEvent: vi.fn(async (e) => { store.ops.push(e); return { id: `ops_${++store.seq}`, fields: {} }; }),
    // members
    findMemberByEmail: vi.fn(async (e) => store.members.get(String(e).toLowerCase()) ?? null),
    upsertMemberByEmail: vi.fn(async () => ({})),
    updateDiscordSyncStatus: vi.fn(async () => ({})),
    updateEntitlementState: vi.fn(async () => ({})),
    upsertDiscordLink: vi.fn(async () => ({})),
    isDiscordAuthNonceUsed: vi.fn(async () => false),
    markDiscordAuthNonceUsed: vi.fn(async () => ({})),
    listPendingDiscordSync: vi.fn(async () => []),
    listOutOfSyncEntitlements: vi.fn(async () => []),
    listLapsedMonthlyWithoutExpiry: vi.fn(async () => []),
    dbConfigured: vi.fn(() => true),
  };
}

/** Env the real tiers/entitlements/crossmint/email/discord modules need. */
export const ENV = {
  CROSSMINT_API_KEY: 'ck_test',
  CROSSMINT_COLLECTION_ID: 'col_test',
  RESEND_API_KEY: 're_test',
  RESEND_FROM_EMAIL: 'noreply@aurevonvc.com',
  STATE_SECRET: 'test_state',
  DISCORD_INVITE_URL: 'https://discord.gg/x',
  DISCORD_ROLE_MONTHLY: 'role_m',
  DISCORD_ROLE_LIFETIME: 'role_l',
  DISCORD_ROLE_PRODUCT_A: 'role_a',
  DISCORD_ROLE_PRODUCT_B: 'role_b',
  DISCORD_ROLE_PRODUCT_C: 'role_c',
  STRIPE_SECRET_KEY: 'sk_test_x',
  PAYPAL_BUSINESS_EMAIL: 'biz@aurevonvc.com',
  INTERNAL_API_SECRET: 'internal_secret_0123456789',
};

const UNSET = [
  'CROSSMINT_ENV', 'CROSSMINT_CHAIN', 'PAYPAL_MODE', 'ALERT_WEBHOOK_URL', 'DOMAIN',
  'CROSSMINT_COLLECTION_MONTHLY', 'CROSSMINT_COLLECTION_LIFETIME',
  'CROSSMINT_COLLECTION_PRODUCT_A', 'CROSSMINT_COLLECTION_PRODUCT_B', 'CROSSMINT_COLLECTION_PRODUCT_C',
  'AIRTABLE_PAT', 'AIRTABLE_BASE_ID',
];

export function applyEnv() {
  for (const k of UNSET) delete process.env[k];
  Object.assign(process.env, ENV);
}

export function installFetch(store) {
  const fetchMock = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    let body = opts.body;
    try { body = JSON.parse(opts.body); } catch { /* form / empty */ }
    const call = { url: u, method: opts.method ?? 'GET', body };
    store.calls.push(call);
    if (u.includes('ipnpb')) return { ok: true, status: 200, text: async () => 'VERIFIED' };
    if (u.includes('/collections/') && u.includes('/nfts')) {
      if (store.crossmintStatus !== 200) {
        return { ok: false, status: store.crossmintStatus, json: async () => ({ message: 'crossmint unavailable' }) };
      }
      const n = ++store.seq;
      return { ok: true, status: 200, json: async () => ({ actionId: `act_${n}`, id: `nft_${n}` }) };
    }
    if (u.includes('api.resend.com/emails')) {
      if (store.resendFails) return { ok: false, status: 500, text: async () => '{"message":"resend down"}' };
      return { ok: true, status: 200, json: async () => ({ id: `em_${++store.seq}` }), text: async () => '' };
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export const crossmintCalls = (store) => store.calls.filter((c) => c.url.includes('/collections/'));
export const resendCalls = (store) => store.calls.filter((c) => c.url.includes('api.resend.com'));

/** tier key per provider for each of the five NFTs. */
export const NFT_CASES = [
  // nftType, entitlementKey, prefix, stripe checkout key, canonical key, amount
  ['Aurevon Insider', 'product_a_reward', 'INSIDER', 're_full', 'full', 250],
  ['Aurevon Ember', 'product_b_reward', 'EMBER', 're_retainer', 'retainer', 1499],
  ['Aurevon Obsidian Executive', 'product_c_reward', 'OBSIDIAN', 're_enterprise', 'enterprise', 2499],
  ['001 Genesis', 'monthly_membership', 'GENESIS', 'comm_monthly', 'comm_monthly', 29.99],
  ['004 Chrome', 'lifetime_membership', 'CHROME', 'comm_lifetime', 'comm_lifetime', 349.99],
];

const PASS_TYPE = { full: 'INSIDER', retainer: 'EMBER', enterprise: 'OBSIDIAN', comm_monthly: 'GENESIS', comm_lifetime: 'CHROME' };
const SUBSCRIPTION = new Set(['re_retainer', 're_enterprise', 'comm_monthly', 'retainer', 'enterprise']);

function mockRes() {
  return {
    statusCode: 0, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    send(b) { this.body = b; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
}

/**
 * One delivery per provider. `id` is the provider transaction id; `tier` is the
 * provider-side key (Stripe checkout key / canonical key for PayPal and manual).
 */
export const deliver = {
  async stripe({ id, tier, amount, email, name = 'Gold Buyer' }) {
    const { handleCheckoutSessionCompleted } = await import('../../../webhooks/stripe.js');
    const sub = SUBSCRIPTION.has(tier);
    await handleCheckoutSessionCompleted({
      id,
      payment_status: 'paid',
      mode: sub ? 'subscription' : 'payment',
      ...(sub ? { subscription: `sub_${id}` } : {}),
      customer_details: { email, name },
      amount_total: Math.round(amount * 100),
      metadata: { tier },
    });
  },
  async paypal({ id, tier, amount, email, name = 'Gold Buyer' }) {
    const { processIPN } = await import('../../../webhooks/paypal.js');
    const [first_name, last_name] = name.split(' ');
    const raw = new URLSearchParams({
      txn_id: id,
      payer_email: email,
      first_name, last_name,
      mc_gross: amount.toFixed(2),
      mc_currency: 'USD',
      payment_status: 'Completed',
      receiver_email: ENV.PAYPAL_BUSINESS_EMAIL,
      custom: JSON.stringify({ tier }),
    }).toString();
    await processIPN(raw);
  },
  async manual({ id, tier, email, name = 'Gold Buyer' }) {
    const { default: handler } = await import('../../../member/claim.js');
    const res = mockRes();
    await handler({
      method: 'POST',
      query: { action: 'mint' },
      headers: { authorization: `Bearer ${ENV.INTERNAL_API_SECRET}` },
      body: { recipientEmail: email, passType: PASS_TYPE[tier], transactionId: id, customerName: name },
    }, res);
    return res;
  },
};

/** Stripe ids must match the intake gate's cs_(test|live)_[A-Za-z0-9]+; PayPal txn ids are alphanumeric. */
export function txnId(provider, tag) {
  if (provider === 'stripe') return `cs_test_${tag}`;
  if (provider === 'paypal') return `PP${tag}`.slice(0, 32);
  return `manual-${tag}`;
}

/** The provider-side tier key for an NFT case. */
export function providerTier(provider, checkoutKey, canonicalKey) {
  return provider === 'stripe' ? checkoutKey : canonicalKey;
}
