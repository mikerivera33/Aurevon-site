/**
 * Health check endpoint — GET /api/health
 *
 * Returns pipeline status and confirms which env vars are wired.
 * Never reveals values — only presence (true/false).
 */

const VERSION = '1.0.0';

const REQUIRED_ENV_VARS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'PAYPAL_BUSINESS_EMAIL',
    'PAYPAL_CLIENT_ID',
  'PAYPAL_SECRET',
  'CROSSMINT_API_KEY',
  'CROSSMINT_PROJECT_ID',
  'CROSSMINT_COLLECTION_ID',
  'CROSSMINT_TEMPLATE_INSIDER',
  'CROSSMINT_TEMPLATE_EMBER',
  'CROSSMINT_TEMPLATE_OBSIDIAN',
  'CROSSMINT_TEMPLATE_GENESIS',
  'CROSSMINT_TEMPLATE_CHROME',
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
  'RESEND_FROM_NAME',
  'AIRTABLE_PAT',
  'AIRTABLE_BASE_ID',
  'DISCORD_INVITE_URL',
];

export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const env_check = Object.fromEntries(
    REQUIRED_ENV_VARS.map((key) => [key, Boolean(process.env[key])])
  );

  const allSet = Object.values(env_check).every(Boolean);
  const missingCount = Object.values(env_check).filter((v) => !v).length;

  return res.status(200).json({
    ok: true,
    version: VERSION,
    timestamp: new Date().toISOString(),
    pipeline: 'Aurevon NFT Minting Pipeline',
    status: allSet ? 'fully_wired' : `${missingCount}_env_var(s)_missing`,
    env_check,
  });
}
