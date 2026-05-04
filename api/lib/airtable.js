/**
 * Airtable REST API client for Aurevon data persistence.
 *
 * Table IDs:
 *   Leads      → tblDuezyOsxy7sNES
 *   Payments   → tblMPOjy7os3FyO3Q
 *   NFT_Mints  → tblBi4wqjOeWpHAMI
 */

const AIRTABLE_BASE_URL = 'https://api.airtable.com/v0';

const TABLE_IDS = {
  Leads:     'tblDuezyOsxy7sNES',
  Payments:  'tblMPOjy7os3FyO3Q',
  NFT_Mints: 'tblBi4wqjOeWpHAMI',
};

function getHeaders() {
  const pat = process.env.AIRTABLE_PAT;
  if (!pat) throw new Error('Missing AIRTABLE_PAT env var');
  return {
    'Authorization': `Bearer ${pat}`,
    'Content-Type': 'application/json',
  };
}

function getBaseId() {
  return process.env.AIRTABLE_BASE_ID ?? 'app00c03021ILsOrv';
}

async function createRecord(tableId, fields) {
  const baseId = getBaseId();
  const url = `${AIRTABLE_BASE_URL}/${baseId}/${tableId}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ fields }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Airtable createRecord failed (${response.status}) on table ${tableId}: ${errText}`);
  }

  return response.json();
}

async function updateRecord(tableId, recordId, fields) {
  const baseId = getBaseId();
  const url = `${AIRTABLE_BASE_URL}/${baseId}/${tableId}/${recordId}`;

  const response = await fetch(url, {
    method: 'PATCH',
    headers: getHeaders(),
    body: JSON.stringify({ fields }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Airtable updateRecord failed (${response.status}) on table ${tableId}: ${errText}`);
  }

  return response.json();
}

async function listRecords(tableId, { filterFormula, maxRecords = 100 } = {}) {
  const baseId = getBaseId();
  const params = new URLSearchParams({ maxRecords: String(maxRecords) });
  if (filterFormula) params.set('filterByFormula', filterFormula);

  const url = `${AIRTABLE_BASE_URL}/${baseId}/${tableId}?${params}`;

  const response = await fetch(url, { headers: getHeaders() });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Airtable listRecords failed (${response.status}) on table ${tableId}: ${errText}`);
  }

  const data = await response.json();
  return data.records ?? [];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Count NFT_Mints records whose Reference field starts with `{prefix}_`.
 * Used to determine the next serial number for a collection.
 *
 * @param {string} prefix  e.g. 'INSIDER'
 * @returns {Promise<number>}  count of matching records
 */
export async function countNftMintsByPrefix(prefix) {
  const baseId = getBaseId();
  // Airtable FIND returns the position (1-based) of the substring, or 0 if not found.
  // FIND(needle, haystack) = 1 means the field starts with the needle.
  const filterFormula = `FIND("${prefix}_", {Reference}) = 1`;
  const params = new URLSearchParams({
    filterByFormula: filterFormula,
    // We only need the count — fetch minimal fields to keep the response small.
    'fields[]': 'Reference',
    maxRecords: '10000',
  });

  const url = `${AIRTABLE_BASE_URL}/${baseId}/${TABLE_IDS.NFT_Mints}?${params}`;

  let allRecords = [];
  let offset = null;

  // Page through all results (Airtable returns max 100 per page by default)
  do {
    const pageParams = new URLSearchParams(params);
    if (offset) pageParams.set('offset', offset);

    const pageUrl = `${AIRTABLE_BASE_URL}/${baseId}/${TABLE_IDS.NFT_Mints}?${pageParams}`;
    const response = await fetch(pageUrl, { headers: getHeaders() });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Airtable countNftMintsByPrefix failed (${response.status}): ${errText}`);
    }

    const data = await response.json();
    allRecords = allRecords.concat(data.records ?? []);
    offset = data.offset ?? null;
  } while (offset);

  console.log(`[Airtable] countNftMintsByPrefix("${prefix}") → ${allRecords.length}`);
  return allRecords.length;
}

/**
 * Create a Lead record.
 * @param {{ name: string, email: string, tier?: string, source?: string }} opts
 */
export async function createLead({ name, email, tier = '', source = 'Stripe' }) {
  console.log(`[Airtable] Creating Lead for ${email}`);
  return createRecord(TABLE_IDS.Leads, {
    Name: name,
    Email: email,
    Tier: tier,
    Source: source,
    CreatedAt: new Date().toISOString(),
  });
}

/**
 * Create a Payment record.
 * @param {{ transactionId, method, tier, amount, customerEmail, customerName, status, token }} opts
 */
export async function createPayment({
  transactionId,
  method,
  tier,
  amount,
  customerEmail,
  customerName,
  status,
  token,
}) {
  console.log(`[Airtable] Creating Payment record for session ${transactionId}`);
  return createRecord(TABLE_IDS.Payments, {
    TransactionID: transactionId,
    Method: method,
    Tier: tier,
    Amount: amount,
    CustomerEmail: customerEmail,
    CustomerName: customerName,
    Status: status,
    Token: token,
    CreatedAt: new Date().toISOString(),
  });
}

/**
 * Create an NFT_Mints record.
 * The `reference` field carries the serial string (e.g. "EMBER_014") and is the
 * canonical unique identifier for each mint.
 *
 * @param {{ reference, customerEmail, nftType, tierSource, status, sentDate, emailDelivered, notes, mintId, retryCount }} opts
 */
export async function createNftMint({
  reference,
  customerEmail,
  nftType,
  tierSource,
  status,
  sentDate,
  emailDelivered = false,
  notes = '',
  mintId = '',
  retryCount = 0,
}) {
  console.log(`[Airtable] Creating NFT_Mints record ref=${reference}`);
  return createRecord(TABLE_IDS.NFT_Mints, {
    Reference: reference,
    CustomerEmail: customerEmail,
    NFTType: nftType,
    TierSource: tierSource,
    Status: status,
    SentDate: sentDate,
    EmailDelivered: emailDelivered,
    Notes: notes,
    MintID: mintId,
    RetryCount: retryCount,
  });
}

/**
 * Update an NFT_Mints record (used by cron retry).
 */
export async function updateNftMint(recordId, fields) {
  console.log(`[Airtable] Updating NFT_Mints record ${recordId}`);
  return updateRecord(TABLE_IDS.NFT_Mints, recordId, fields);
}

/**
 * List NFT_Mints rows matching a filter formula.
 */
export async function listNftMints(filterFormula) {
  return listRecords(TABLE_IDS.NFT_Mints, { filterFormula, maxRecords: 10 });
}
