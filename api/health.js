/**
 * Health check endpoint — GET /api/health
 *
 * Returns pipeline status and confirms which env vars are wired.
 * Never reveals values — only presence (true/false).
 */

const VERSION = '2.0.0';

const REQUIRED_ENV = [
  // Stripe
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  // PayPal
  'PAYPAL_CLIENT_ID',
  'PAYPAL_SECRET',
  'PAYPAL_BUSINESS_EMAIL',
  // Crossmint
  'CROSSMINT_API_KEY',
  'CROSSMINT_PROJECT_ID',
  'CROSSMINT_COLLECTION_ID',
  'CROSSMINT_TEMPLATE_INSIDER',
  'CROSSMINT_TEMPLATE_EMBER',
  'CROSSMINT_TEMPLATE_OBSIDIAN',
  'CROSSMINT_TEMPLATE_GENESIS',
  'CROSSMINT_TEMPLATE_CHROME',
  // Resend
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
  // Airtable
  'AIRTABLE_PAT',
  'AIRTABLE_BASE_ID',
  // Discord
  'DISCORD_BOT_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_GUILD_ID',
  'DISCORD_INVITE_URL',
  // Entitlement roles
  'DISCORD_ROLE_MONTHLY',
  'DISCORD_ROLE_LIFETIME',
  'DISCORD_ROLE_PRODUCT_A',
  'DISCORD_ROLE_PRODUCT_B',
  'DISCORD_ROLE_PRODUCT_C',
  // Crossmint per-entitlement collections
  'CROSSMINT_COLLECTION_MONTHLY',
  'CROSSMINT_COLLECTION_LIFETIME',
  'CROSSMINT_COLLECTION_PRODUCT_A',
  'CROSSMINT_COLLECTION_PRODUCT_B',
  'CROSSMINT_COLLECTION_PRODUCT_C',
  // Security
  'STATE_SECRET',
  'SYNC_SECRET',
  'RECONCILE_SECRET',
];

const OPTIONAL_ENV = [
  'ENGAGE_IO_API_KEY',
  'ENGAGE_IO_WORKSPACE_ID',
  'COLLABLAND_COMMUNITY_ID',
  'CROSSMINT_WEBHOOK_SECRET',
  'ENTITLEMENT_GRACE_PERIOD_DAYS',
  'CROSSMINT_CHAIN',
  'PAYPAL_SANDBOX',
  'RESEND_FROM_NAME',
];

export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const required = Object.fromEntries(REQUIRED_ENV.map((k) => [k, Boolean(process.env[k])]));
  const optional = Object.fromEntries(OPTIONAL_ENV.map((k) => [k, Boolean(process.env[k])]));

  const allRequired = Object.values(required).every(Boolean);
  const missingCount = Object.values(required).filter((v) => !v).length;
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);

  return res.status(200).json({
    ok: true,
    version: VERSION,
    timestamp: new Date().toISOString(),
    pipeline: 'Aurevon NFT Membership + Discord Automation',
    status: allRequired ? 'fully_wired' : `${missingCount}_required_env_var(s)_missing`,
    missing_required: missing,
    required,
    optional,
    airtable_base: process.env.AIRTABLE_BASE_ID ?? 'appI9X8vcRcK1QZ1l (default)',
    function_count: 12,
    function_limit: 12,
  });
}
