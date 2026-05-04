/**
 * Aurevon NFT Pipeline — Integration Test Script
 *
 * Usage:
 *   node api/test/test-pipeline.js           # dry run (logs only, no real API calls)
 *   TEST_LIVE=true node api/test/...          # calls real APIs (requires env vars set)
 *
 * Simulates a Stripe checkout.session.completed event and walks through
 * all pipeline steps with mock implementations unless TEST_LIVE=true.
 */

import { TIER_NFT_MAP, inferTierFromAmount, resolveTemplateId, formatSerial, getNextSerial } from '../lib/tiers.js';

const IS_LIVE = process.env.TEST_LIVE === 'true';

// ---------------------------------------------------------------------------
// Mock setup (overrides real modules when not live)
// ---------------------------------------------------------------------------

const mockResults = {
  airtablePayment: null,
  airtableMint: null,
  crossmintMint: null,
  resendEmail: null,
};

if (!IS_LIVE) {
  console.log('\n[TEST] Running in DRY RUN mode — no real API calls will be made.\n');
  console.log('[TEST] Set TEST_LIVE=true to call real APIs.\n');
  console.log('━'.repeat(60));
}

// ---------------------------------------------------------------------------
// Mock env vars (only if not already set)
// ---------------------------------------------------------------------------

const mockEnv = {
  STRIPE_WEBHOOK_SECRET: 'whsec_test_mock',
  CROSSMINT_API_KEY: 'sk_test_mock_crossmint',
  CROSSMINT_PROJECT_ID: 'proj_mock',
  CROSSMINT_COLLECTION_ID: 'col_mock',
  CROSSMINT_TEMPLATE_INSIDER: 'tmpl_insider_mock',
  CROSSMINT_TEMPLATE_EMBER: 'tmpl_ember_mock',
  CROSSMINT_TEMPLATE_OBSIDIAN: 'tmpl_obsidian_mock',
  CROSSMINT_TEMPLATE_GENESIS: 'tmpl_genesis_mock',
  CROSSMINT_TEMPLATE_CHROME: 'tmpl_chrome_mock',
  RESEND_API_KEY: 're_mock_key',
  RESEND_FROM_EMAIL: 'hello@aurevongroup.com',
  RESEND_FROM_NAME: 'Aurevon',
  AIRTABLE_PAT: 'pat_mock_token',
  AIRTABLE_BASE_ID: 'app00c03021ILsOrv',
  DISCORD_INVITE_URL: 'https://discord.gg/GdYRZtdvNS',
};

for (const [key, val] of Object.entries(mockEnv)) {
  if (!process.env[key]) process.env[key] = val;
}

// ---------------------------------------------------------------------------
// Unit tests for serial helpers
// ---------------------------------------------------------------------------

function runSerialUnitTests() {
  console.log('\n\x1b[1m===== SERIAL UNIT TESTS =====\x1b[0m');
  let passed = 0;
  let failed = 0;

  function assert(label, actual, expected) {
    if (actual === expected) {
      console.log(`  \x1b[32mPASS\x1b[0m  ${label}  → ${actual}`);
      passed++;
    } else {
      console.log(`  \x1b[31mFAIL\x1b[0m  ${label}  expected=${expected} got=${actual}`);
      failed++;
    }
  }

  // formatSerial tests
  assert('formatSerial("EMBER", 1)',    formatSerial('EMBER', 1),    'EMBER_001');
  assert('formatSerial("EMBER", 14)',   formatSerial('EMBER', 14),   'EMBER_014');
  assert('formatSerial("INSIDER", 1)',  formatSerial('INSIDER', 1),  'INSIDER_001');
  assert('formatSerial("GENESIS", 127)',formatSerial('GENESIS', 127),'GENESIS_127');
  assert('formatSerial("CHROME", 999)', formatSerial('CHROME', 999), 'CHROME_999');
  assert('formatSerial("OBSIDIAN", 1000)', formatSerial('OBSIDIAN', 1000), 'OBSIDIAN_1000');

  // getNextSerial with mocked countNftMintsByPrefix (count=0 → returns PREFIX_001)
  // We test the formatSerial logic which is the pure core; getNextSerial integrates Airtable.
  assert('formatSerial gives _001 when count=0', formatSerial('INSIDER', 0 + 1), 'INSIDER_001');
  assert('formatSerial gives _002 when count=1', formatSerial('EMBER',   1 + 1), 'EMBER_002');

  console.log(`\n  Serial unit tests: ${passed} passed, ${failed} failed`);
  return failed;
}

// ---------------------------------------------------------------------------
// Simulated Stripe event
// ---------------------------------------------------------------------------

const TEST_CASES = [
  {
    label: 'Full Package ($250)',
    session: {
      id: 'cs_test_full_abc123456789',
      amount_total: 25000, // cents
      metadata: { tier: 'full' },
      customer_email: 'test-full@example.com',
      customer_details: { email: 'test-full@example.com', name: 'Jane Operator' },
    },
    expectedSerial: 'INSIDER',
  },
  {
    label: 'Community Monthly ($29.99) — inferred from amount',
    session: {
      id: 'cs_test_comm_abc987654321',
      amount_total: 2999,
      metadata: {},  // no tier in metadata
      customer_email: 'test-comm@example.com',
      customer_details: { email: 'test-comm@example.com', name: 'Bob Builder' },
    },
    expectedSerial: 'GENESIS',
  },
  {
    label: 'Second Opinion ($189.99) — no NFT tier',
    session: {
      id: 'cs_test_single_xyz111222333',
      amount_total: 18999,
      metadata: { tier: 'single' },
      customer_email: 'test-single@example.com',
      customer_details: { email: 'test-single@example.com', name: 'Alice Advisor' },
    },
    expectedSerial: null,
  },
  {
    label: 'Enterprise ($2499)',
    session: {
      id: 'cs_test_ent_zzz999888777',
      amount_total: 249900,
      metadata: { tier: 'enterprise' },
      customer_email: 'test-enterprise@example.com',
      customer_details: { email: 'test-enterprise@example.com', name: 'Carlos CEO' },
    },
    expectedSerial: 'OBSIDIAN',
  },
];

// ---------------------------------------------------------------------------
// Simulated pipeline steps
// ---------------------------------------------------------------------------

async function simulateStep(name, fn) {
  process.stdout.write(`  ${name}... `);
  try {
    const result = await fn();
    console.log('\x1b[32mOK\x1b[0m', result !== undefined ? `→ ${JSON.stringify(result)}` : '');
    return result;
  } catch (err) {
    console.log(`\x1b[31mFAILED\x1b[0m — ${err.message}`);
    return null;
  }
}

async function runTestCase({ label, session, expectedSerial }) {
  console.log(`\n\x1b[1m[TEST CASE] ${label}\x1b[0m`);
  console.log(`  Session: ${session.id}`);
  console.log(`  Amount:  $${session.amount_total / 100}`);
  console.log(`  Email:   ${session.customer_details.email}`);
  console.log('');

  // Step 1 — Tier resolution
  let tier = session.metadata?.tier || null;
  if (!tier) {
    tier = inferTierFromAmount(session.amount_total);
    console.log(`  [Step 1] No metadata.tier — inferred tier="${tier}" from amount`);
  } else {
    console.log(`  [Step 1] Tier from metadata: "${tier}"`);
  }

  // Step 2 — NFT mapping
  const tierConfig = TIER_NFT_MAP[tier] ?? null;
  const nftType = tierConfig?.nft ?? null;
  const templateKey = tierConfig?.template ?? null;
  const serialPrefix = tierConfig?.serialPrefix ?? null;
  const collectionName = tierConfig?.collectionName ?? null;
  const templateId = resolveTemplateId(templateKey);
  console.log(`  [Step 2] NFT type: "${nftType ?? 'NONE'}" | serialPrefix: ${serialPrefix ?? 'N/A'} | collectionName: ${collectionName ?? 'N/A'}`);
  console.log(`           templateKey: ${templateKey} | templateId: ${templateId ?? 'N/A'}`);

  // Verify serial prefix matches expectation
  if (expectedSerial !== null && serialPrefix !== expectedSerial) {
    console.log(`  \x1b[31m[WARN]\x1b[0m  Expected serialPrefix="${expectedSerial}", got "${serialPrefix}"`);
  } else if (expectedSerial === null && serialPrefix === null) {
    console.log(`  \x1b[32m[OK]\x1b[0m    No serial prefix (correct for no-NFT tier)`);
  } else if (expectedSerial !== null) {
    console.log(`  \x1b[32m[OK]\x1b[0m    serialPrefix="${serialPrefix}" matches expected`);
  }

  if (!IS_LIVE) {
    // Dry run simulation — mock a serial
    const mockSerial = serialPrefix ? formatSerial(serialPrefix, 1) : null;
    const mockEdition = mockSerial ? parseInt(mockSerial.split('_')[1], 10) : null;

    await simulateStep('[Step 3] Airtable createPayment', () => ({
      id: 'rec_mock_payment_' + Math.random().toString(36).slice(2),
      fields: { TransactionID: session.id, Status: 'Succeeded' },
    }));

    if (!nftType) {
      console.log(`  [Step 4] No NFT for this tier. Would send purchase confirmation email.`);
      await simulateStep('[Step 5] Resend sendPurchaseConfirmation', () => ({ id: 'email_mock_confirm' }));
      return;
    }

    console.log(`  [Step 3b] Serial assigned: ${mockSerial ?? 'none'}`);

    const mintId = 'mint_mock_' + Math.random().toString(36).slice(2);
    await simulateStep('[Step 4] Crossmint mintToEmail', () => ({
      mintId,
      imageUrl: `https://example.com/nft/${mintId}.png`,
      serial: mockSerial,
      collection: collectionName,
      tier: tier,
    }));

    await simulateStep('[Step 5] Airtable createNftMint', () => ({
      id: 'rec_mock_nft_' + Math.random().toString(36).slice(2),
      fields: { Status: 'Sent', MintID: mintId, Reference: mockSerial },
    }));

    const mockEditionDisplay = mockEdition != null ? String(mockEdition).padStart(3, '0') : null;
    const mockSubject = mockEditionDisplay
      ? `Your ${nftType} #${mockEditionDisplay} is here — Welcome to Aurevon`
      : `Your ${nftType} NFT is live — Welcome to Aurevon`;

    await simulateStep('[Step 6] Resend sendNftDelivery', () => ({
      id: 'email_mock_delivery',
      subject: mockSubject,
      serial: mockSerial,
      edition: mockEdition,
    }));

    console.log(`  \x1b[32m[OK]\x1b[0m    Email subject includes serial: "${mockSubject}"`);

  } else {
    // Live mode — import and call real modules
    const { createPayment, createNftMint } = await import('../lib/airtable.js');
    const { mintToEmail } = await import('../lib/crossmint.js');
    const { sendNftDelivery, sendPurchaseConfirmation } = await import('../lib/email.js');

    const amount = session.amount_total / 100;
    const customerEmail = session.customer_details.email;
    const customerName = session.customer_details.name;
    const now = new Date().toISOString();

    await simulateStep('[Step 3] Airtable createPayment', () =>
      createPayment({
        transactionId: session.id,
        method: 'Stripe Card',
        tier,
        amount,
        customerEmail,
        customerName,
        status: 'Succeeded',
        token: `paid_${tier}_${Date.now()}`,
      })
    );

    if (!nftType) {
      console.log('  [Step 4] No NFT — sending confirmation email');
      await simulateStep('[Step 5] Resend sendPurchaseConfirmation', () =>
        sendPurchaseConfirmation({ email: customerEmail, customerName, tier })
      );
      return;
    }

    // Get next serial
    let serial = null;
    if (serialPrefix) {
      const serialResult = await simulateStep('[Step 3b] getNextSerial', () =>
        getNextSerial(serialPrefix)
      );
      serial = serialResult;
    }

    const edition = serial ? parseInt(serial.split('_')[1], 10) : null;

    let mintId = null;
    let imageUrl = null;
    const mintResult = await simulateStep('[Step 4] Crossmint mintToEmail', () =>
      mintToEmail({ email: customerEmail, nftType, customerName, templateKey, serial, collectionName, tierKey: tier })
    );
    if (mintResult) {
      mintId = mintResult.mintId;
      imageUrl = mintResult.imageUrl;
    }

    await simulateStep('[Step 5] Airtable createNftMint', () =>
      createNftMint({
        reference: serial ?? `MINT_${session.id.slice(-8)}_${nftType.replace(/\s+/g, '_')}`,
        customerEmail,
        nftType,
        tierSource: tier,
        status: mintId ? 'Sent' : 'Failed',
        sentDate: now,
        emailDelivered: Boolean(mintId),
        mintId: mintId ?? '',
        retryCount: 0,
      })
    );

    await simulateStep('[Step 6] Resend sendNftDelivery', () =>
      sendNftDelivery({
        email: customerEmail,
        customerName,
        nftType,
        mintId: mintId ?? 'pending',
        nftImageUrl: imageUrl,
        discordInviteUrl: process.env.DISCORD_INVITE_URL,
        tier,
        serial,
        edition,
      })
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n\x1b[1m===== Aurevon NFT PIPELINE TEST =====\x1b[0m');
  console.log(`Mode: ${IS_LIVE ? '\x1b[33mLIVE\x1b[0m (real API calls)' : '\x1b[36mDRY RUN\x1b[0m (mock responses)'}`);
  console.log(`Date: ${new Date().toISOString()}`);

  // Run pure unit tests first
  const unitFailures = runSerialUnitTests();

  for (const tc of TEST_CASES) {
    await runTestCase(tc);
  }

  console.log('\n\x1b[1m===== TIER MAP SUMMARY =====\x1b[0m');
  for (const [tier, config] of Object.entries(TIER_NFT_MAP)) {
    const templateId = resolveTemplateId(config.template);
    const nftStatus = config.nft ? `\x1b[32m${config.nft}\x1b[0m` : '\x1b[33mNO NFT\x1b[0m';
    const serialStr = config.serialPrefix ? `\x1b[36m${config.serialPrefix}_NNN\x1b[0m` : '—';
    console.log(`  ${tier.padEnd(14)} $${String(config.amount).padEnd(8)} → ${nftStatus}  serial=${serialStr}  collection="${config.collectionName ?? 'N/A'}"`);
  }

  if (unitFailures > 0) {
    console.log(`\n\x1b[31m[WARN]\x1b[0m ${unitFailures} serial unit test(s) failed.`);
  } else {
    console.log('\n\x1b[32m[DONE]\x1b[0m All serial unit tests passed.');
  }

  console.log('\x1b[32m[DONE]\x1b[0m All test cases completed.\n');
}

main().catch((err) => {
  console.error('\x1b[31m[FATAL]\x1b[0m', err);
  process.exit(1);
});
