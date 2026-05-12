/**
 * Engage.io / Engage AI integration wrapper.
 *
 * Engage.io docs: https://engage.so/docs/api
 *
 * Triggers used in Aurevon:
 *   1. entitlement_activated  — fire when NFT mint succeeds + Discord role assigned
 *   2. discord_link_reminder  — fire when buyer hasn't linked Discord after N hours
 *   3. subscription_cancelled — fire when monthly entitlement is revoked
 *
 * Set ENGAGE_IO_API_KEY and ENGAGE_IO_WORKSPACE_ID in Vercel env vars.
 * If these are absent, events are logged locally and skipped (non-fatal).
 */

const BASE_URL = 'https://api.engage.so/v1';

function getHeaders() {
  const key = process.env.ENGAGE_IO_API_KEY;
  if (!key) return null; // Will cause graceful skip
  // Engage uses HTTP Basic auth: API key as username, empty password
  const encoded = Buffer.from(`${key}:`).toString('base64');
  return {
    Authorization: `Basic ${encoded}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Identify / upsert a user in Engage.
 * This creates/updates the contact and sets attributes.
 *
 * @param {{ uid: string, email: string, name?: string, attributes?: Record<string, any> }} opts
 */
export async function engageIdentify({ uid, email, name, attributes = {} }) {
  const headers = getHeaders();
  if (!headers) {
    console.log(`[Engage] ENGAGE_IO_API_KEY not set — skipping identify for ${email}`);
    return null;
  }

  const workspace = process.env.ENGAGE_IO_WORKSPACE_ID;
  if (!workspace) {
    console.log(`[Engage] ENGAGE_IO_WORKSPACE_ID not set — skipping identify for ${email}`);
    return null;
  }

  const body = {
    uid: uid ?? email,
    email,
    ...(name ? { first_name: name.split(' ')[0], last_name: name.split(' ').slice(1).join(' ') || undefined } : {}),
    ...attributes,
  };

  try {
    const res = await fetch(`${BASE_URL}/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.warn(`[Engage] identify failed (${res.status}): ${txt}`);
      return null;
    }
    console.log(`[Engage] identified user uid=${uid ?? email}`);
    return res.json();
  } catch (err) {
    console.warn(`[Engage] identify error: ${err.message}`);
    return null;
  }
}

/**
 * Track an event in Engage for a user.
 *
 * @param {{ uid: string, email: string, event: string, properties?: Record<string, any> }} opts
 */
export async function engageTrack({ uid, email, event, properties = {} }) {
  const headers = getHeaders();
  if (!headers) {
    console.log(`[Engage] ENGAGE_IO_API_KEY not set — skipping event "${event}" for ${email}`);
    return null;
  }

  const body = {
    uid: uid ?? email,
    event,
    properties,
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch(`${BASE_URL}/users/${encodeURIComponent(uid ?? email)}/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.warn(`[Engage] track "${event}" failed (${res.status}): ${txt}`);
      return null;
    }
    console.log(`[Engage] tracked event="${event}" uid=${uid ?? email}`);
    return res.json();
  } catch (err) {
    console.warn(`[Engage] track error: ${err.message}`);
    return null;
  }
}

// ── Pre-built trigger functions ───────────────────────────────────────────────

/**
 * Fire when a member's entitlement is activated (NFT minted + Discord role assigned).
 *
 * @param {{ email: string, name?: string, entitlementType: string, nftType: string, serial?: string }} opts
 */
export async function onEntitlementActivated({ email, name, entitlementType, nftType, serial }) {
  await engageIdentify({
    uid: email,
    email,
    name,
    attributes: {
      entitlement_type: entitlementType,
      nft_type: nftType,
      nft_serial: serial ?? '',
      membership_active: true,
      activated_at: new Date().toISOString(),
    },
  });
  return engageTrack({
    uid: email,
    email,
    event: 'entitlement_activated',
    properties: { entitlement_type: entitlementType, nft_type: nftType, serial: serial ?? '' },
  });
}

/**
 * Fire when a monthly subscription is cancelled/revoked.
 *
 * @param {{ email: string, entitlementType: string }} opts
 */
export async function onSubscriptionCancelled({ email, entitlementType }) {
  await engageIdentify({
    uid: email,
    email,
    attributes: { membership_active: false, cancelled_at: new Date().toISOString() },
  });
  return engageTrack({
    uid: email,
    email,
    event: 'subscription_cancelled',
    properties: { entitlement_type: entitlementType },
  });
}

/**
 * Fire when a buyer has not linked their Discord account after a delay.
 * Typically called from a scheduled job or reconcile pass.
 *
 * @param {{ email: string, name?: string, nftType: string }} opts
 */
export async function onDiscordLinkReminder({ email, name, nftType }) {
  return engageTrack({
    uid: email,
    email,
    event: 'discord_link_reminder',
    properties: { nft_type: nftType, name: name ?? '' },
  });
}
