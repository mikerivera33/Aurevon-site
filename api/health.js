/**
 * Health check endpoint — GET /api/health
 *
 * Returns pipeline status and confirms which env vars are wired.
 * Never reveals values — only presence (true/false).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '2.1.0';

// Vercel Pro: 100 serverless functions per project (Hobby is 12).
const FUNCTION_LIMIT = 100;

// Count actual deployable functions on disk so the report doesn't drift as
// files are added/removed. Same exclusions as .vercelignore + the _lib/_archived/
// helper-only paths that Vercel never wraps as functions.
const FUNCTION_COUNT = (() => {
  const apiDir = path.dirname(fileURLToPath(import.meta.url));
  const EXCLUDE_DIRS = new Set(['_lib', '_archived', 'test', 'cron', 'lib']);
  function countJs(dir) {
    let n = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) continue;
        n += countJs(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        n += 1;
      }
    }
    return n;
  }
  try { return countJs(apiDir); } catch { return 0; }
})();

const REQUIRED_ENV = [
      // Stripe
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      // PayPal
      'PAYPAL_CLIENT_ID',
      'PAYPAL_SECRET',
      'PAYPAL_BUSINESS_EMAIL',
      // Crossmint (core — required for any NFT mint)
      'CROSSMINT_API_KEY',
      'CROSSMINT_COLLECTION_ID',
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
      // Security
      'STATE_SECRET',
      'SYNC_SECRET',
      'RECONCILE_SECRET',
    ];

const OPTIONAL_ENV = [
      // Crossmint optional — template IDs per tier (legacy single-collection mode)
      'CROSSMINT_TEMPLATE_INSIDER',
      'CROSSMINT_TEMPLATE_EMBER',
      'CROSSMINT_TEMPLATE_OBSIDIAN',
      'CROSSMINT_TEMPLATE_GENESIS',
      'CROSSMINT_TEMPLATE_CHROME',
      // Crossmint optional — per-entitlement collection IDs (new entitlement system)
      'CROSSMINT_COLLECTION_MONTHLY',
      'CROSSMINT_COLLECTION_LIFETIME',
      'CROSSMINT_COLLECTION_PRODUCT_A',
      'CROSSMINT_COLLECTION_PRODUCT_B',
      'CROSSMINT_COLLECTION_PRODUCT_C',
      // Crossmint optional
      'CROSSMINT_PROJECT_ID',
      'CROSSMINT_WEBHOOK_SECRET',
      'CROSSMINT_CHAIN',
      // Other optional integrations
      'ENGAGE_IO_API_KEY',
      'ENGAGE_IO_WORKSPACE_ID',
      'COLLABLAND_COMMUNITY_ID',
      'ENTITLEMENT_GRACE_PERIOD_DAYS',
      'PAYPAL_SANDBOX',
      'RESEND_FROM_NAME',
      'DISCORD_ROLE_VERIFIED',
    ];

export default function handler(req, res) {
      if (req.method !== 'GET') {
              return res.status(405).json({ error: 'Method not allowed' });
      }

  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
      const allRequired = missing.length === 0;
      const optionalPresent = OPTIONAL_ENV.filter((k) => Boolean(process.env[k])).length;

  return res.status(200).json({
          ok: true,
          status: 'healthy',
          version: VERSION,
          timestamp: new Date().toISOString(),
          pipeline: 'Aurevon NFT Membership + Discord Automation',
          env: allRequired ? 'complete' : 'partial',
          missing_required: allRequired ? [] : missing,
          optional_env: `${optionalPresent}/${OPTIONAL_ENV.length}`,
          function_count: FUNCTION_COUNT,
          function_limit: FUNCTION_LIMIT,
  });
}
