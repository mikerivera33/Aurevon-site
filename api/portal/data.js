// api/portal/data.js — Customer data endpoint (server-side Airtable fetch)
// POST { email, sessionToken } → validates session, returns customer's leads/payments/nfts/profile

export default async function handler(req, res) {
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
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const airtableHeaders = {
    Authorization: `Bearer ${AIRTABLE_PAT}`,
    'Content-Type': 'application/json',
  };

  // Generic Airtable fetch with filter formula
  async function fetchRecords(tableId, formula, fields = []) {
    const encoded = encodeURIComponent(formula);
    let url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${tableId}?filterByFormula=${encoded}&maxRecords=100`;
    if (fields.length > 0) {
      fields.forEach(f => { url += `&fields[]=${encodeURIComponent(f)}`; });
    }
    const resp = await fetch(url, { headers: airtableHeaders });
    if (!resp.ok) {
      const err = await resp.text();
      console.error(`Airtable fetch error [${tableId}]:`, err);
      return [];
    }
    const data = await resp.json();
    return data.records || [];
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

    // Fetch all customer data in parallel
    const emailFilter = `LOWER({Email})="${normalizedEmail}"`;

    const [leadRecords, paymentRecords, nftRecords] = await Promise.all([
      fetchRecords('tblDuezyOsxy7sNES', emailFilter),
      fetchRecords('tblMPOjy7os3FyO3Q', emailFilter),
      fetchRecords('tblBi4wqjOeWpHAMI', emailFilter),
    ]);

    // Shape leads
    const leads = leadRecords.map(r => ({
      id: r.id,
      property: r.fields['Property Address'] || r.fields['Address'] || r.fields['Property'] || '',
      tier: r.fields['Tier'] || r.fields['Package'] || '',
      status: r.fields['Status'] || 'New',
      submitted: r.fields['Created'] || r.fields['Date'] || r.createdTime,
      analyst: r.fields['Analyst'] || r.fields['Assigned To'] || '',
      notes: r.fields['Notes'] || '',
      estimatedDelivery: r.fields['Estimated Delivery'] || r.fields['Est. Delivery'] || '',
    }));

    // Shape payments
    const payments = paymentRecords.map(r => ({
      id: r.id,
      date: r.fields['Date'] || r.fields['Payment Date'] || r.createdTime,
      tier: r.fields['Tier'] || r.fields['Package'] || '',
      amount: r.fields['Amount'] || r.fields['Amount Paid'] || 0,
      method: r.fields['Method'] || r.fields['Payment Method'] || '',
      status: r.fields['Status'] || r.fields['Payment Status'] || '',
    }));

    // Shape NFTs
    const nfts = nftRecords.map(r => ({
      id: r.id,
      type: r.fields['NFT Type'] || r.fields['Collection'] || r.fields['Type'] || '',
      serial: r.fields['Serial Number'] || r.fields['Serial'] || r.fields['Token ID'] || '',
      status: r.fields['Status'] || r.fields['Mint Status'] || '',
      collection: r.fields['Collection Name'] || r.fields['Collection'] || '',
      dateSent: r.fields['Date Sent'] || r.fields['Sent Date'] || r.createdTime,
      mintTx: r.fields['Mint Tx'] || r.fields['Transaction Hash'] || r.fields['Tx Hash'] || '',
      imageUrl: r.fields['Image URL'] || '',
    }));

    // Profile from CustomerAuth
    const profile = {
      name: authFields['Customer Name'] || '',
      email: normalizedEmail,
      discordId: authFields['Discord ID'] || '',
      notes: authFields['Notes'] || '',
      lastLogin: authFields['Last Login'] || '',
    };

    // Compute highest tier from payments + leads
    const tierRank = { genesis: 4, obsidian: 3, ember: 2, chrome: 1, insider: 1 };
    let highestTier = '';
    let highestRank = 0;
    [...payments, ...leads].forEach(r => {
      const t = (r.tier || '').toLowerCase();
      for (const [tier, rank] of Object.entries(tierRank)) {
        if (t.includes(tier) && rank > highestRank) {
          highestRank = rank;
          highestTier = tier.charAt(0).toUpperCase() + tier.slice(1);
        }
      }
    });
    profile.tier = highestTier;

    // Member since = earliest payment date
    const paymentDates = payments
      .map(p => p.date)
      .filter(Boolean)
      .sort();
    profile.memberSince = paymentDates[0] || '';

    return res.status(200).json({ profile, leads, payments, nfts });
  } catch (err) {
    console.error('data.js error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
