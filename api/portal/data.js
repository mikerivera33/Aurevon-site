// api/portal/data.js — Customer data endpoint for Aurevon Operations
// POST { email, sessionToken } → validates session, returns customer's payments/NFTs/profile
// Airtable Base: appI9X8vcRcK1QZ1l (Aurevon Operations)

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
  // Aurevon Operations base ID
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'appI9X8vcRcK1QZ1l';

  // Aurevon Operations table IDs
  const AUTH_TABLE = 'tblbCS7TL65FcOiWn';       // CustomerAuth
  const PAYMENTS_TABLE = 'tbl6KlhM9fIH19W5i';   // Payments
  const NFT_TABLE = 'tbliXEGJdoEIAJU06';        // NFT_Mints
  const MEMBERS_TABLE = 'tblYPn7hxnrgH723B';     // Members

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
      if (fields.length > 0) { fields.forEach(f => { url += `&fields[]=${encodeURIComponent(f)}`; }); }
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
      AUTH_TABLE,
      `LOWER({Email})="${normalizedEmail}"`,
    );

    if (authRecords.length === 0) {
      return res.status(401).json({ error: 'Session not found' });
    }

    const authRecord = authRecords[0];
    const authFields = authRecord.fields;

    // Check that session is active AND token matches (prevents email-only access)
    if (!authFields['Session Active'] || authFields['Magic Link Token'] !== sessionToken) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }

    // Fetch customer data in parallel
    const emailFormula = `LOWER({Email})="${normalizedEmail}"`;
    const [paymentRecords, nftRecords, memberRecords] = await Promise.all([
      fetchRecords(PAYMENTS_TABLE, emailFormula),
      fetchRecords(NFT_TABLE, emailFormula),
      fetchRecords(MEMBERS_TABLE, emailFormula),
    ]);

    // Format payments
    const payments = paymentRecords.map(r => ({
      id: r.id,
      serviceProduct: r.fields['Service Product'] || '',
      amount: r.fields['amount'] || r.fields['Amount'] || 0,
      status: r.fields['status'] || r.fields['Status'] || '',
      deliverableStatus: r.fields['Deliverable Status'] || 'Not Started',
      deliveryNotes: r.fields['Delivery Notes'] || '',
      paymentDate: r.fields['Payment Date'] || '',
      paymentProvider: r.fields['payment_provider'] || r.fields['Payment Provider'] || '',
    }));

    // Format NFTs
    const nfts = nftRecords.map(r => ({
      id: r.id,
      nftType: r.fields['NFT Type'] || '',
      tokenId: r.fields['Token ID'] || '',
      mintStatus: r.fields['Mint Status'] || 'Pending',
      discordRoleAssigned: r.fields['Discord Synced'] || false,
      mintDate: r.fields['Mint Date'] || '',
      transactionHash: r.fields['Transaction Hash'] || '',
    }));

    // Member profile
    const member = memberRecords[0]?.fields || {};

    // Build response
    const customerName = authFields['Customer Name'] || member['Customer Name'] || '';
    const memberTier = authFields['Member Tier'] || member['Member Tier'] || 'Free';

    return res.status(200).json({
      success: true,
      profile: {
        email: normalizedEmail,
        customerName,
        memberTier,
        joinDate: member['Join Date'] || '',
        active: member['Active'] || false,
        discordUsername: member['Discord Username'] || '',
        nftHoldings: member['NFT Holdings'] || '',
      },
      payments,
      nfts,
      summary: {
        totalPayments: payments.length,
        activeNFTs: nfts.filter(n => n.mintStatus === 'Minted').length,
        pendingDeliverables: payments.filter(p => p.deliverableStatus === 'Not Started' || p.deliverableStatus === 'In Progress').length,
      },
    });
  } catch (err) {
    console.error('data.js error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
