/**
 * NFT fulfilment — the one path every paid NFT takes, whoever took the money.
 *
 * Called by the Stripe webhook, the PayPal IPN handler and the direct-mint
 * endpoint (POST /api/member/claim?action=mint) AFTER they have written their
 * own Payments idempotency marker. This module never imports a webhook module.
 *
 *   tier → entitlement → (existing row?) → serial → Crossmint → NFT_Mints row
 *        → delivery email → Discord re-sync
 *
 * Ordering is deliberate: the serial is reserved BEFORE the mint and goes
 * on-chain with it, then the row is inserted. A serial collision found at
 * insert time after a successful mint is never re-minted (the NFT already
 * carries that serial); the row gets a `_dup` reference and an alert.
 *
 * Expected failures (mint failed, email failed, row dropped) alert and return —
 * they never throw. Only programmer errors (missing transactionId / email) throw.
 *
 * Privacy: never log recipient emails; alert details carry ids only.
 */

import { getNextSerial, canonicalTier } from './tiers.js';
import { ENTITLEMENT_MAP, resolveEntitlementFromSku } from './entitlements.js';
import { mintToEmail } from './crossmint.js';
import { createNftMint, findMintByPaymentId, updateNftMint, findMemberByEmail, updateDiscordSyncStatus } from './db.js';
import { sendNftDelivery } from './email.js';
import { sendAlert } from './alert.js';

async function alert(event, detail) {
  await sendAlert(event, detail).catch(() => {});
}

/**
 * The serial a stored Reference carries, or null. `PREFIX_NNN` is a serial;
 * `PREFIX_NNN_dupXXXX` / `PREFIX_NNN_rXXXX` are collision fallbacks whose mint
 * request went out with `PREFIX_NNN`, so a retry reuses it (same idempotent PUT,
 * same metadata). `MINT_…` / `RECOVER_…` / anything else carries no serial.
 */
export function serialFromReference(reference, prefix) {
  const m = new RegExp(`^(${prefix}_\\d+)(?:_(?:dup|r)[A-Za-z0-9]+)?$`).exec(String(reference ?? ''));
  return m ? m[1] : null;
}

function existingResult(row, entitlementKey, nftType) {
  return {
    minted: true,
    existing: true,
    entitlementKey,
    nftType,
    serial: row?.fields?.['Reference'] ?? null,
    actionId: row?.fields?.['Crossmint Action ID'] || row?.fields?.['Token ID'] || null,
    rowId: row?.id ?? null,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.transactionId - payment id (Stripe cs_…, PayPal txn, manual-…); the mint idempotency key
 * @param {string} opts.email - buyer email (recipient of the custodial NFT + delivery email)
 * @param {string} [opts.customerName]
 * @param {string} opts.tier - checkout or canonical tier key (re_full / full / comm_monthly …)
 * @param {string} opts.provider - 'stripe' | 'paypal' | 'manual' — prefixes alert names
 * @param {string} [opts.source] - 'webhook' | 'manual' … (logging only)
 * @param {string|null} [opts.walletAddress] - deliver on-chain to this wallet instead of the email's custodial wallet
 * @returns {Promise<{ minted: boolean, reason?: 'no_nft', existing?: true, entitlementKey?: string,
 *   nftType?: string, serial?: string|null, actionId?: string|null, rowId?: string|null }>}
 */
export async function fulfilNft({ transactionId, email, customerName, tier, provider, source = 'webhook', walletAddress = null } = {}) {
  if (!transactionId) throw new Error('fulfilNft: transactionId is required');
  if (!email) throw new Error('fulfilNft: email is required');

  // 1. Entitlement — only the five NFTs; bogo/single/deal/addon_* resolve to null.
  const entitlementKey = resolveEntitlementFromSku(tier);
  if (!entitlementKey) return { minted: false, reason: 'no_nft' };

  const txn = String(transactionId);
  const to = String(email).trim().toLowerCase();
  const p = provider || 'fulfil';
  const cfg = ENTITLEMENT_MAP[entitlementKey];
  const { nftType, serialPrefix: prefix } = cfg;
  const tierSource = canonicalTier(tier);
  const tag = `[fulfil:${p}/${source}]`;

  // 2. One mint per payment. A Failed row is retried in place (same serial).
  let retryRow = null;
  try {
    const prior = await findMintByPaymentId(txn);
    if (prior) {
      if (prior.fields?.['Mint Status'] !== 'Failed') {
        console.log(`${tag} ${txn} already has mint row ${prior.id} — no re-mint`);
        return existingResult(prior, entitlementKey, nftType);
      }
      retryRow = prior;
    }
  } catch (err) {
    // The Crossmint PUT is idempotent on txn and the row insert is UNIQUE on
    // the payment, so carrying on cannot double-mint.
    console.error(`${tag} findMintByPaymentId failed for ${txn}: ${err.message}`);
    await alert(`${p}.mint_lookup_failed`, { transactionId: txn, error: err.message });
  }

  // 3. Serial — reserved once, before the mint.
  let serial = null;
  if (retryRow) {
    serial = serialFromReference(retryRow.fields?.['Reference'], prefix);
  } else {
    try {
      serial = await getNextSerial(prefix);
    } catch (err) {
      console.error(`${tag} serial reservation failed for ${prefix}: ${err.message}`);
      await alert(`${p}.serial_failed`, { transactionId: txn, prefix, error: err.message });
    }
  }

  // 4. Mint.
  let status;
  let actionId = null;
  let imageUrl = null;
  let notes = '';
  try {
    const result = await mintToEmail({ email: to, walletAddress, nftType, serial, idempotencyKey: txn, entitlementKey });
    if (!result?.ok) throw new Error(result?.error ?? 'Crossmint returned ok:false');
    status = 'Sent';
    actionId = result.actionId ?? null;
    imageUrl = result.imageUrl ?? null;
    console.log(`${tag} minted ${nftType} for ${txn}: actionId=${actionId} serial=${serial}`);
  } catch (err) {
    status = 'Failed';
    notes = `Crossmint error: ${err.message}`;
    console.error(`${tag} mint failed for ${txn}: ${err.message}`);
    await alert(`${p}.mint_failed`, { transactionId: txn, tier: tierSource, nftType, error: err.message });
  }
  const minted = status === 'Sent';
  const now = new Date().toISOString();

  // 5. Record it.
  let row = null;
  let displaySerial = serial;
  if (retryRow) {
    const retryCount = Number(retryRow.fields?.['Retry Count'] ?? 0) + 1;
    try {
      row = await updateNftMint(retryRow.id, {
        'Mint Status': status,
        'Token ID': actionId ?? '',
        'Crossmint Action ID': actionId ?? '',
        'Notes': notes,
        'Last Error': minted ? '' : notes,
        'Retry Count': retryCount,
      });
      row = row?.id ? row : retryRow;
    } catch (err) {
      console.error(`${tag} updateNftMint failed for ${retryRow.id}: ${err.message}`);
      await alert(`${p}.mint_row_dropped`, { transactionId: txn, tier: tierSource, nftType, minted, error: err.message });
      row = null;
    }
    // Never the stored fallback reference (MINT_…/RECOVER_…): it is not a
    // serial, and the email would derive a bogus edition from it.
    displaySerial = serial ?? null;
  } else {
    const fields = {
      email: to,
      nftType,
      tierSource,
      status,
      sentDate: now,
      emailDelivered: false,
      notes,
      mintId: actionId ?? '',
      crossmintActionId: actionId ?? '',
      paymentTransactionId: txn,
      entitlementType: entitlementKey,
      retryCount: 0,
    };
    const reference = serial ?? `MINT_${txn.slice(-8)}_${prefix}`;
    const insert = (ref) => createNftMint({ reference: ref, ...fields });
    // A concurrent run for this payment wrote the row and owns delivery: hand
    // its row back — no mint_row_dropped alert, no email from this run.
    const concurrentRow = async () => {
      console.log(`${tag} ${txn} mint row written concurrently — returning it`);
      const existing = await findMintByPaymentId(txn).catch(() => null);
      return existingResult(existing, entitlementKey, nftType);
    };
    // Second insert (collision fallback reference). Returns the row, null when
    // dropped (alerted), or RACED when a concurrent run won the payment.
    const RACED = Symbol('raced');
    const insertFallback = async (ref, what) => {
      try {
        return await insert(ref);
      } catch (e2) {
        if (e2.code === 'DUPLICATE_PAYMENT_MINT') return RACED;
        console.error(`${tag} createNftMint (${what}) failed for ${txn}: ${e2.message}`);
        await alert(`${p}.mint_row_dropped`, { transactionId: txn, tier: tierSource, nftType, minted, error: e2.message });
        return null;
      }
    };
    try {
      row = await insert(reference);
    } catch (err) {
      if (err.code === 'DUPLICATE_PAYMENT_MINT') return concurrentRow();
      if (err.code === 'DUPLICATE_REFERENCE' && minted) {
        // The NFT already carries this serial on-chain: never re-mint. Keep the
        // row (and the payment link) under a distinguishable reference.
        const dupRef = `${reference}_dup${txn.slice(-4)}`;
        await alert(`${p}.serial_collision`, { transactionId: txn, serial: reference, reference: dupRef });
        row = await insertFallback(dupRef, 'dup ref');
        if (row === RACED) return concurrentRow();
      } else if (err.code === 'DUPLICATE_REFERENCE') {
        // Nothing landed on-chain with this serial yet: take a fresh one, once.
        // Without one, `_r` keeps the row retryable: the retry reuses `reference`
        // (the serial this mint request carried) — see serialFromReference.
        const fresh = await getNextSerial(prefix).catch(() => null);
        const ref = fresh ?? `${reference}_r${txn.slice(-4)}`;
        row = await insertFallback(ref, 'fresh serial');
        if (row === RACED) return concurrentRow();
        if (row) displaySerial = fresh;
      } else {
        // Minted on-chain but unrecorded is an orphan: orphan-recovery + the
        // idempotent key self-heal it, but it must never be silent.
        console.error(`${tag} createNftMint failed for ${txn}: ${err.message}`);
        await alert(`${p}.mint_row_dropped`, { transactionId: txn, tier: tierSource, nftType, minted, error: err.message });
      }
    }
  }

  // 6. Tell the buyer — the real pass when minted, "being finalized" otherwise.
  // A failed RETRY sends nothing: the buyer already has the "being finalized"
  // email from the first attempt, and a re-run job must never re-email it.
  const skipEmail = Boolean(retryRow) && !minted;
  if (skipEmail) console.log(`${tag} retry for ${txn} still failing — no repeat "pending" email`);
  if (!skipEmail) {
    try {
      await sendNftDelivery({
        email: to,
        customerName,
        nftType,
        mintId: actionId ?? 'pending',
        nftImageUrl: imageUrl,
        discordInviteUrl: process.env.DISCORD_INVITE_URL,
        tier: tierSource,
        serial: displaySerial,
        status: minted ? 'minted' : 'pending',
        transactionId: txn,
      });
      if (minted && row?.id) {
        await updateNftMint(row.id, { 'Email Delivered': true }).catch((err) => {
          console.error(`${tag} could not flag Email Delivered on ${row.id}: ${err.message}`);
        });
      }
    } catch (err) {
      console.error(`${tag} delivery email failed for ${txn}: ${err.message}`);
      await alert(`${p}.email_failed`, { transactionId: txn, nftType, minted, error: err.message });
    }
  }

  // 7. A member who already linked Discord gets the new role on the next reconcile.
  if (minted) {
    try {
      const member = await findMemberByEmail(to);
      if (member?.fields?.['Discord ID']) await updateDiscordSyncStatus(to, 'pending');
    } catch (err) {
      console.error(`${tag} Discord re-sync flag failed for ${txn}: ${err.message}`);
    }
  }

  return { minted, entitlementKey, nftType, serial: displaySerial, actionId, rowId: row?.id ?? null };
}
