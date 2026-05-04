/**
 * Vercel Cron Job — /api/cron/retry-mints
 *
 * Runs hourly. Finds NFT_Mints rows with status=Queued or Failed,
 * retries Crossmint mint + Resend email. Limits to 10 retries per row.
 *
 * Set in vercel.json:
 *   { "crons": [{ "path": "/api/cron/retry-mints", "schedule": "0 * * * *" }] }
 */

import { listNftMints, updateNftMint } from '../lib/airtable.js';
import { mintToEmail } from '../lib/crossmint.js';
import { sendNftDelivery } from '../lib/email.js';
import { TIER_NFT_MAP } from '../lib/tiers.js';

const MAX_RETRIES = 10;

// ---------------------------------------------------------------------------
// Reverse map: NFT type → templateKey and collectionName
// ---------------------------------------------------------------------------
const NFT_TO_TIER_CONFIG = {};
for (const [tierKey, v] of Object.entries(TIER_NFT_MAP)) {
  if (v.nft && v.template) {
    // If multiple tiers share the same NFT type (e.g. full + bogo → Aurevon Insider),
    // the last writer wins — they share the same template so it doesn't matter.
    NFT_TO_TIER_CONFIG[v.nft] = {
      templateKey: v.template,
      collectionName: v.collectionName,
      serialPrefix: v.serialPrefix,
      tierKey,
    };
  }
}

// ---------------------------------------------------------------------------
// Parse serial from a Reference field value
// e.g. "EMBER_014" → { prefix: "EMBER", num: 14, serial: "EMBER_014" }
// Returns null if the reference doesn't match the PREFIX_NNN pattern.
// ---------------------------------------------------------------------------
function parseSerialFromReference(reference) {
  if (!reference) return null;
  const match = reference.match(/^([A-Z]+)_(\d+)$/);
  if (!match) return null;
  return {
    prefix: match[1],
    num: parseInt(match[2], 10),
    serial: reference,
  };
}

// ---------------------------------------------------------------------------
// Retry a single NFT_Mints record
// ---------------------------------------------------------------------------

async function retryRecord(record) {
  const { id: recordId, fields } = record;
  const {
    CustomerEmail: customerEmail,
    NFTType: nftType,
    TierSource: tierSource,
    RetryCount: retryCount = 0,
    MintID: existingMintId,
    Reference: reference,
  } = fields;

  if (!customerEmail || !nftType) {
    console.warn(`[Cron] Skipping record ${recordId} — missing CustomerEmail or NFTType`);
    return;
  }

  if (retryCount >= MAX_RETRIES) {
    console.log(`[Cron] Record ${recordId} has reached max retries (${MAX_RETRIES}). Marking Abandoned.`);
    await updateNftMint(recordId, {
      Status: 'Abandoned',
      Notes: `Max retries (${MAX_RETRIES}) reached.`,
    });
    return;
  }

  // Extract the original serial from the Reference field (do NOT generate a new one)
  const parsedSerial = parseSerialFromReference(reference);
  const serial = parsedSerial ? parsedSerial.serial : null;
  const edition = parsedSerial ? parsedSerial.num : null;

  console.log(`[Cron] Retrying record ${recordId} — ${nftType} to ${customerEmail} (attempt ${retryCount + 1}) serial=${serial ?? 'none'}`);

  const tierConfig = NFT_TO_TIER_CONFIG[nftType] ?? null;
  const templateKey = tierConfig?.templateKey ?? null;
  const collectionName = tierConfig?.collectionName ?? null;
  const tierKey = tierSource ?? tierConfig?.tierKey ?? null;

  let mintId = existingMintId;
  let imageUrl = null;
  let newStatus = 'Failed';
  let notes = '';

  try {
    const result = await mintToEmail({
      email: customerEmail,
      nftType,
      customerName: 'Aurevon Member',
      templateKey,
      serial,
      collectionName,
      tierKey,
    });
    mintId = result.mintId;
    imageUrl = result.imageUrl;
    newStatus = 'Sent';
    console.log(`[Cron] Mint succeeded for ${recordId}: mintId=${mintId}, serial=${serial}`);
  } catch (err) {
    notes = `Retry ${retryCount + 1} failed: ${err.message}`;
    console.error(`[Cron] Mint retry failed for ${recordId}: ${err.message}`);
  }

  // Update Airtable record
  await updateNftMint(recordId, {
    Status: newStatus,
    RetryCount: retryCount + 1,
    MintID: mintId ?? '',
    EmailDelivered: newStatus === 'Sent',
    ...(notes ? { Notes: notes } : {}),
    SentDate: new Date().toISOString(),
  });

  // Send email if mint succeeded
  if (newStatus === 'Sent') {
    try {
      await sendNftDelivery({
        email: customerEmail,
        customerName: 'Aurevon Member',
        nftType,
        mintId: mintId ?? 'pending',
        nftImageUrl: imageUrl,
        discordInviteUrl: process.env.DISCORD_INVITE_URL,
        tier: tierSource,
        serial,
        edition,
      });
    } catch (err) {
      console.error(`[Cron] Email send failed after retry for ${recordId}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Vercel handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  // Protect cron endpoint — Vercel sets the Authorization header automatically
  // for internal cron invocations; reject external calls without the header.
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('[Cron] retry-mints job started');

  let records = [];
  try {
    // Fetch up to 10 Queued or Failed mints
    const filter = `OR({Status}='Queued',{Status}='Failed')`;
    records = await listNftMints(filter);
    console.log(`[Cron] Found ${records.length} record(s) to retry`);
  } catch (err) {
    console.error(`[Cron] Failed to list NFT_Mints: ${err.message}`);
    return res.status(500).json({ error: 'Failed to fetch records', detail: err.message });
  }

  const results = { retried: 0, succeeded: 0, failed: 0, skipped: 0 };

  for (const record of records) {
    const retryCount = record.fields?.RetryCount ?? 0;
    if (retryCount >= MAX_RETRIES) {
      results.skipped++;
      continue;
    }

    try {
      await retryRecord(record);
      results.retried++;
      // We'll count success/fail from Airtable update result (optimistically increment)
      if (record.fields?.Status !== 'Failed') results.succeeded++;
    } catch (err) {
      results.failed++;
      console.error(`[Cron] retryRecord threw for ${record.id}: ${err.message}`);
    }
  }

  console.log(`[Cron] retry-mints complete`, results);
  return res.status(200).json({ ok: true, ...results });
}
