/**
 * PayPal IPN handler — POST /api/webhooks/paypal
 *
 * PayPal sends form-encoded POST data (IPN = Instant Payment Notification).
 * Verification: re-POST the exact body back to PayPal IPN endpoint with
 * "cmd=_notify-validate" prepended — PayPal responds "VERIFIED" or "INVALID".
 *
 * Same downstream pipeline as Stripe: Airtable → Crossmint → Airtable → Resend.
 */

import { TIER_NFT_MAP, getNextSerial, formatSerial } from '../_lib/tiers.js';
import { mintToEmail } from '../_lib/crossmint.js';
import { createPayment, createNftMint } from '../_lib/airtable.js';
import { sendNftDelivery, sendPurchaseConfirmation } from '../_lib/email.js';

const PAYPAL_IPN_VERIFY_URL_LIVE    = 'https://ipnpb.paypal.com/cgi-bin/webscr';
const PAYPAL_IPN_VERIFY_URL_SANDBOX = 'https://ipnpb.sandbox.paypal.com/cgi-bin/webscr';

// ---------------------------------------------------------------------------
// IPN Verification
// ---------------------------------------------------------------------------

async function verifyPayPalIPN(rawBody) {
  const verifyUrl = process.env.PAYPAL_SANDBOX === 'true'
    ? PAYPAL_IPN_VERIFY_URL_SANDBOX
    : PAYPAL_IPN_VERIFY_URL_LIVE;

  // PayPal requires the exact raw body with cmd=_notify-validate prepended
  const verifyBody = `cmd=_notify-validate&${rawBody}`;

  const response = await fetch(verifyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: verifyBody,
  });

  const result = await response.text();
  console.log(`[PayPal IPN] Verification result: ${result}`);
  return result.trim() === 'VERIFIED';
}

// ---------------------------------------------------------------------------
// Parse form-encoded IPN payload
// ---------------------------------------------------------------------------

function parseIPN(rawBody) {
  const params = new URLSearchParams(rawBody);
  const out = {};
  for (const [key, value] of params.entries()) {
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Infer tier from IPN data
// ---------------------------------------------------------------------------

function inferTierFromIPN(ipn) {
  // Custom field can carry tier metadata: set in PayPal button/link as "custom" field
  if (ipn.custom) {
    try {
      const custom = JSON.parse(ipn.custom);
      if (custom.tier) return custom.tier;
    } catch {
      // custom is a plain string
      if (TIER_NFT_MAP[ipn.custom]) return ipn.custom;
    }
  }

  // Fallback: infer from mc_gross (payment amount)
  const amount = parseFloat(ipn.mc_gross ?? '0');
  const tolerance = 1;

  for (const [tier, config] of Object.entries(TIER_NFT_MAP)) {
    if (Math.abs(amount - config.amount) <= tolerance) return tier;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Core pipeline (mirrors stripe handler)
// ---------------------------------------------------------------------------

async function handleVerifiedIPN(ipn) {
  const txnId = ipn.txn_id ?? `pp_${Date.now()}`;
  const customerEmail = ipn.payer_email;
  const customerName = [ipn.first_name, ipn.last_name].filter(Boolean).join(' ') || 'Aurevon Member';
  const amount = parseFloat(ipn.mc_gross ?? '0');
  const paymentStatus = (ipn.payment_status ?? '').toLowerCase();
  const now = new Date().toISOString();

  if (!customerEmail) {
    console.error(`[PayPal IPN] No payer_email in IPN txnId=${txnId} — aborting pipeline`);
    return;
  }

  console.log(`[PayPal IPN] Processing txnId=${txnId} for ${customerEmail} amount=${amount} status=${paymentStatus}`);

  // Only process completed payments
  if (paymentStatus !== 'completed') {
    console.log(`[PayPal IPN] Skipping non-completed payment (status=${paymentStatus})`);
    return;
  }

  // Validate receiver email to prevent fraud
  const businessEmail = process.env.PAYPAL_BUSINESS_EMAIL;
  if (!businessEmail) {
    console.warn('[PayPal IPN] PAYPAL_BUSINESS_EMAIL not set — receiver email validation skipped');
  } else if (ipn.receiver_email !== businessEmail) {
    console.warn(`[PayPal IPN] Receiver mismatch: got ${ipn.receiver_email}, expected ${businessEmail}`);
    return;
  }

  const tier = inferTierFromIPN(ipn);
  const token = `paid_${tier ?? 'unknown'}_${Date.now()}`;

  // Write Payments row
  try {
    await createPayment({
      transactionId: txnId,
      method: 'PayPal',
      tier: tier ?? 'unknown',
      amount,
      customerEmail,
      customerName,
      status: 'Succeeded',
      token,
    });
  } catch (err) {
    console.error(`[PayPal IPN] Airtable createPayment failed: ${err.message}`);
  }

  const tierConfig = tier ? (TIER_NFT_MAP[tier] ?? null) : null;
  const nftType = tierConfig?.nft ?? null;
  const templateKey = tierConfig?.template ?? null;
  const serialPrefix = tierConfig?.serialPrefix ?? null;
  const collectionName = tierConfig?.collectionName ?? null;

  // No NFT tier
  if (!nftType) {
    console.log(`[PayPal IPN] Tier "${tier}" has no NFT. Sending purchase confirmation.`);
    try {
      await sendPurchaseConfirmation({ email: customerEmail, customerName, tier: tier ?? 'unknown' });
    } catch (err) {
      console.error(`[PayPal IPN] Confirmation email failed: ${err.message}`);
    }
    return;
  }

  // Get next serial number for this collection
  let serial = null;
  if (serialPrefix) {
    try {
      serial = await getNextSerial(serialPrefix);
      console.log(`[PayPal IPN] Assigned serial ${serial} for tier "${tier}"`);
    } catch (err) {
      console.error(`[PayPal IPN] getNextSerial failed: ${err.message}. Continuing without serial.`);
    }
  }

  // Mint NFT
  let mintId = null;
  let imageUrl = null;
  let mintStatus;
  let mintNotes = '';

  try {
    const result = await mintToEmail({
      email: customerEmail,
      nftType,
      customerName,
      templateKey,
      serial,
      collectionName,
      tierKey: tier,
    });
    if (!result.ok) throw new Error(result.error ?? 'Crossmint API returned ok:false');
    mintId = result.actionId;
    imageUrl = result.imageUrl ?? null;
    mintStatus = 'Sent';
    console.log(`[PayPal IPN] Mint succeeded: mintId=${mintId}, serial=${serial}`);
  } catch (err) {
    mintStatus = 'Failed';
    mintNotes = `Crossmint error: ${err.message}`;
    console.error(`[PayPal IPN] Crossmint mint failed: ${err.message}`);
  }

  // Write NFT_Mints row — use serial as reference; retry on collision (race condition guard)
  const reference = serial ?? `MINT_${txnId.slice(-8)}_${nftType.replace(/\s+/g, '_')}`;
  let insertedSerial = serial;

  for (let attempt = 0; attempt < 3; attempt++) {
    const ref = attempt === 0 ? reference : (() => {
      if (!insertedSerial) return reference;
      const parts = insertedSerial.split('_');
      const prefix = parts[0];
      const num = parseInt(parts[1] ?? '0', 10) + 1;
      insertedSerial = formatSerial(prefix, num);
      return insertedSerial;
    })();

    try {
      await createNftMint({
        reference: ref,
        email: customerEmail,
        nftType,
        tierSource: tier,
        status: mintStatus,
        sentDate: now,
        emailDelivered: mintStatus === 'Sent',
        notes: mintNotes,
        mintId: mintId ?? '',
        retryCount: 0,
      });
      console.log(`[PayPal IPN] NFT_Mints record created with reference=${ref}`);
      break;
    } catch (err) {
      const isDuplicate = err.message.includes('422') || err.message.toLowerCase().includes('already exists') || err.message.toLowerCase().includes('duplicate');
      if (isDuplicate && attempt < 2) {
        console.warn(`[PayPal IPN] Reference collision on "${ref}" (attempt ${attempt + 1}) — incrementing serial and retrying`);
      } else {
        console.error(`[PayPal IPN] Airtable createNftMint failed (attempt ${attempt + 1}): ${err.message}`);
        break;
      }
    }
  }

  // Parse edition number from serial for email
  let edition = null;
  if (insertedSerial) {
    const parts = insertedSerial.split('_');
    if (parts[1]) edition = parseInt(parts[1], 10);
  }

  // Send delivery email
  try {
    await sendNftDelivery({
      email: customerEmail,
      customerName,
      nftType,
      mintId: mintId ?? 'pending',
      nftImageUrl: imageUrl,
      discordInviteUrl: process.env.DISCORD_INVITE_URL,
      tier,
      serial: insertedSerial,
      edition,
    });
  } catch (err) {
    console.error(`[PayPal IPN] Resend email failed: ${err.message}`);
  }

  console.log(`[PayPal IPN] Pipeline complete for txnId=${txnId}`);
}

// ---------------------------------------------------------------------------
// Vercel handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Read raw body (form-encoded)
  let rawBody;
  try {
    rawBody = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  } catch (err) {
    console.error(`[PayPal IPN] Failed to read body: ${err.message}`);
    return res.status(400).send('Failed to read body');
  }

  // PayPal expects HTTP 200 to acknowledge receipt immediately
  res.status(200).send('OK');

  // Verify with PayPal
  let verified;
  try {
    verified = await verifyPayPalIPN(rawBody);
  } catch (err) {
    console.error(`[PayPal IPN] Verification request failed: ${err.message}`);
    return;
  }

  if (!verified) {
    console.warn('[PayPal IPN] IPN verification returned INVALID — discarding');
    return;
  }

  const ipn = parseIPN(rawBody);
  console.log(`[PayPal IPN] Verified. txn_id=${ipn.txn_id}, payment_status=${ipn.payment_status}`);

  try {
    await handleVerifiedIPN(ipn);
  } catch (err) {
    console.error(`[PayPal IPN] Unhandled pipeline error: ${err.message}`, err.stack);
  }
}

export const config = {
  api: {
    bodyParser: false,
  },
};
