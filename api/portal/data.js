// api/portal/data.js — Customer data endpoint (server-side Airtable fetch)
// POST { email, sessionToken } → validates session, returns customer's leads/payments/nfts/profile

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, sessionToken } = req.body || {};

  if (!email || !sessionToken) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'app00c03021ILsOrv';

  if (!AIRTABLE_PAT) {
    console.error('AIRTABLE_PAT environment variable is not set');
    return res.status(500).json({ error: 'Portal not yet configured' });
  }

  const airtableHeaders = {
    Authorization: `Bearer ${AIRTABLE_PAT}`,
    'Content-Type': 'application/json',
  };

  // Generic Airtable fetch with filter formula
  async function fetchRecords(tableId, formula, fields = []) {
    try {
      const encoded = encodeURIComponent(formula);
      let url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableId}?filterByFormula=${encoded}&maxRecords=100`;
      if (fields.length > 0) {
        fields.forEach(f => { url += `&fields[]=${encodeURIComponent(f)}`; });
      }
      const resp = await fetch(url, { headers: airtableHeaders });
      if (!resp.ok) {
        console.error(`Airtable fetch error [${tableId}]:`, await resp.text());
        return [];
      }
      const data = await resp.json();
      return data.records || [];
    } catch (e) {
      console.error(`fetchRecords exception [${tableId}]:`, e);
      return [];
    }
  }

  try {
    // Verify session against CustomerAuth
    const authRecords = await fetchRecords(
      'tbl1UGOLPxZRW7vB2',
      `LOWER({Email})="${normalizedEmail}"`
    );

    if (authRecords.length === 0) {
      return res.status(401).json({ error: 'Session not found' });
    }

    const authRecord = authRecords[0];
    const authFields = authRecord.fields;

    // Validate session token and active status
    if (!authFields['Session Active'] || authFields['Session Token'] !== sessionToken) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    // Fetch customer data in parallel
    const emailFormula = `LOWER({Email})="${normalizedEmail}"`;
    const [paymentRecords, nftRecords, leadRecords, memberRecords] = await Promise.all([
      fetchRecords('tblMPOjy7os3FyO3Q', emailFormula),
      fetchRecords('tblNFTMintsTableId', emailFormula),
      fetchRecords('tblDuezyOsxy7sNES', emailFormula),
      fetchRecords('tblMembersTableId', emailFormula),
    ]);

    // Build profile from auth record and member records
    const profile = {
      name: authFields['Customer Name'] || '',
      email: normalizedEmail,
      tier: memberRecords[0]?.fields?.tier || paymentRecords[0]?.fields?.tier || '',
      discordJoined: memberRecords[0]?.fields?.discord_joined || false,
      joinedAt: memberRecords[0]?.fields?.joined_at || paymentRecords[0]?.fields?.created_at || '',
      active: memberRecords[0]?.fields?.active !== false,
    };

    // Format payments
    const payments = paymentRecords.map(r => ({
      id: r.id,
      tier: r.fields.tier || '',
      amount: r.fields.amount || 0,
      provider: r.fields.payment_provider || '',
      status: r.fields.status || '',
      date: r.fields.created_at || '',
    }));

    // Format NFTs
    const nfts = nftRecords.map(r => ({
      id: r.id,
      tier: r.fields.tier || '',
      status: r.fields.status || '',
      crossmintOrderId: r.fields.crossmint_order_id || '',
      chain: r.fields.chain || 'polygon',
      mintedAt: r.fields.mint_at || '',
    }));

    // Format leads
    const leads = leadRecords.map(r => ({
      id: r.id,
      service: r.fields.service || '',
      status: r.fields.status || '',
      message: r.fields.message || '',
      date: r.fields.created_at || '',
    }));

    return res.status(200).json({ profile, payments, nfts, leads });
  } catch (err) {
    console.error('data.js error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
