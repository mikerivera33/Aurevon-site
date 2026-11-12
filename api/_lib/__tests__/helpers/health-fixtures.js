/**
 * Shared fixtures for the /api/health tests: a fully wired production-like env
 * (dummy values), healthy Crossmint/Discord fetch responses, and fresh cron
 * heartbeats. Test files still declare their own vi.mock calls (they are hoisted).
 */
import { vi } from 'vitest';

export const SECRET = 'health_diag_secret_0123456789';

export const ROLE_IDS = {
  DISCORD_ROLE_MONTHLY: '150910712306860001',
  DISCORD_ROLE_LIFETIME: '150910712306860002',
  DISCORD_ROLE_PRODUCT_A: '150910712306860003',
  DISCORD_ROLE_PRODUCT_B: '150910712306860004',
  DISCORD_ROLE_PRODUCT_C: '150910712306860005',
};

/** Every REQUIRED_ENV name set (values are dummies). */
export const HEALTHY_ENV = {
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
  PAYPAL_BUSINESS_EMAIL: 'pay@aurevon.test',
  CROSSMINT_API_KEY: 'cm_key_dummy',
  CROSSMINT_COLLECTION_ID: 'col-123',
  CROSSMINT_WEBHOOK_SECRET: 'whsec_cm_dummy',
  RESEND_API_KEY: 're_dummy',
  RESEND_FROM_EMAIL: 'from@aurevon.test',
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_dummy',
  ADMIN_SECRET: 'admin_dummy',
  ALERT_WEBHOOK_URL: 'https://hooks.example.com/abc',
  DISCORD_BOT_TOKEN: 'bot_token_dummy',
  DISCORD_CLIENT_ID: 'client_id_value',
  DISCORD_CLIENT_SECRET: 'client_secret_value',
  DISCORD_GUILD_ID: '149952681349022120',
  DISCORD_INVITE_URL: 'https://discord.gg/x',
  ...ROLE_IDS,
  STATE_SECRET: 'state_secret_value',
  SYNC_SECRET: 'sync_secret_value',
  RECONCILE_SECRET: 'reconcile_secret_value',
  INTERNAL_API_SECRET: SECRET,
  CRON_SECRET: 'cron_secret_value',
};

export const ALL_STRIPE_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
];

export function endpointList(enabledEvents = ALL_STRIPE_EVENTS, extra = {}) {
  return {
    data: [
      { url: 'https://other.example.com/hook', status: 'enabled', enabled_events: ['*'] },
      { url: 'https://www.aurevonvc.com/api/webhooks/stripe', status: 'enabled', enabled_events: enabledEvents, ...extra },
    ],
  };
}

/** Clear any env that would leak in from the shell, then apply `env`. */
export function applyEnv(env) {
  for (const k of Object.keys(process.env)) {
    if (/^(STRIPE|PAYPAL|CROSSMINT|RESEND|SUPABASE|DISCORD|ALERT|OWNER|ADMIN|STATE|SYNC|RECONCILE|INTERNAL|CRON|AIRTABLE)/i.test(k)) delete process.env[k];
  }
  Object.assign(process.env, env);
}

/** Healthy Crossmint + Discord answers; `overrides` maps a URL substring to a response. */
export function healthyFetch(overrides = {}) {
  const fn = vi.fn(async (url) => {
    for (const [frag, resp] of Object.entries(overrides)) if (String(url).includes(frag)) return typeof resp === 'function' ? resp(url) : resp;
    if (String(url).endsWith('/roles')) {
      return { ok: true, status: 200, json: async () => Object.values(ROLE_IDS).map((id) => ({ id, name: `r${id}` })) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** lastOpsEvent mock impl: fresh ok heartbeats for both crons. */
export function freshHeartbeats(ageMs = 60 * 60_000, extra = {}) {
  const at = new Date(Date.now() - ageMs).toISOString();
  return async (event) => {
    if (event in extra) return extra[event];
    if (event === 'cron.reconcile.ok') return { id: 'h1', fields: { Event: event, 'Created At': at, Detail: { orphanErrors: 0 } } };
    if (event === 'cron.retry_mints.ok') return { id: 'h2', fields: { Event: event, 'Created At': at } };
    return null;
  };
}

export function mockRes() {
  return {
    statusCode: 0,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
}
