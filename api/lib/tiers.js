// Single source of truth for tier → NFT mapping
export const TIER_NFT_MAP = {
  'single':        { nft: null,                        amount: 189.99, template: null,                        serialPrefix: null,    collectionName: null },
  'full':          { nft: 'Aurevon Insider',            amount: 250,    template: 'CROSSMINT_TEMPLATE_INSIDER', serialPrefix: 'INSIDER',   collectionName: 'Aurevon Insider Collection' },
  'bogo':          { nft: 'Aurevon Insider',            amount: 299.99, template: 'CROSSMINT_TEMPLATE_INSIDER', serialPrefix: 'INSIDER',   collectionName: 'Aurevon Insider Collection' },
  'retainer':      { nft: 'Aurevon Ember',              amount: 1499,   template: 'CROSSMINT_TEMPLATE_EMBER',   serialPrefix: 'EMBER',     collectionName: 'Aurevon Ember Collection' },
  'enterprise':    { nft: 'Aurevon Obsidian Executive', amount: 2499,   template: 'CROSSMINT_TEMPLATE_OBSIDIAN',serialPrefix: 'OBSIDIAN',  collectionName: 'Aurevon Obsidian Collection' },
  'comm_monthly':  { nft: '001 Genesis',               amount: 29.99,  template: 'CROSSMINT_TEMPLATE_GENESIS', serialPrefix: 'GENESIS',   collectionName: 'Aurevon Genesis Collection' },
  'comm_lifetime': { nft: '004 Chrome',                amount: 349.99, template: 'CROSSMINT_TEMPLATE_CHROME',  serialPrefix: 'CHROME',    collectionName: 'Aurevon Chrome Collection' },
};

/**
 * Format a serial number as PREFIX_NNN (zero-padded to 3 digits, grows beyond for 1000+).
 * @param {string} prefix  e.g. 'EMBER'
 * @param {number} number  e.g. 14
 * @returns {string}       e.g. 'EMBER_014'
 */
export function formatSerial(prefix, number) {
  const padded = number < 1000 ? String(number).padStart(3, '0') : String(number);
  return `${prefix}_${padded}`;
}

/**
 * Query Airtable NFT_Mints to count records whose Reference starts with the given prefix.
 * Returns the next serial number (count + 1) formatted as PREFIX_NNN.
 *
 * @param {string} prefix  e.g. 'INSIDER'
 * @returns {Promise<string>}  e.g. 'INSIDER_001'
 */
export async function getNextSerial(prefix) {
  const { countNftMintsByPrefix } = await import('./airtable.js');
  const count = await countNftMintsByPrefix(prefix);
  return formatSerial(prefix, count + 1);
}

/**
 * Infer tier from amount_total (Stripe sends amount in cents).
 * Falls back to null if no match found.
 */
export function inferTierFromAmount(amountCents) {
  const amountDollars = amountCents / 100;
  const tolerance = 1; // $1 tolerance for rounding

  for (const [tier, config] of Object.entries(TIER_NFT_MAP)) {
    if (Math.abs(amountDollars - config.amount) <= tolerance) {
      return tier;
    }
  }
  return null;
}

/**
 * Resolve the Crossmint template ID from environment variables
 * given a template key string (e.g. 'CROSSMINT_TEMPLATE_INSIDER').
 */
export function resolveTemplateId(templateKey) {
  if (!templateKey) return null;
  return process.env[templateKey] ?? null;
}
