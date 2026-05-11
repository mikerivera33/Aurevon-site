// api/crossmint/mint.js
// Crossmint NFT minting endpoint - mints the correct pass NFT on Base (ETH L2)
const CROSSMINT_API_KEY = process.env.CROSSMINT_API_KEY;
const CROSSMINT_COLLECTION_ID = process.env.CROSSMINT_COLLECTION_ID;
const CROSSMINT_PROJECT_ID = process.env.CROSSMINT_PROJECT_ID;

const TEMPLATE_MAP = {
  OBSIDIAN: process.env.CROSSMINT_TEMPLATE_OBSIDIAN,
  EMBER:    process.env.CROSSMINT_TEMPLATE_EMBER,
  INSIDER:  process.env.CROSSMINT_TEMPLATE_INSIDER,
  CHROME:   process.env.CROSSMINT_TEMPLATE_CHROME,
  GENESIS:  process.env.CROSSMINT_TEMPLATE_GENESIS,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!CROSSMINT_API_KEY) return res.status(503).json({ error: 'Crossmint not configured', hint: 'Add CROSSMINT_API_KEY to Vercel env vars' });

  const { recipientEmail, walletAddress, passType, metadata } = req.body || {};
  if (!passType) return res.status(400).json({ error: 'Missing passType' });
  if (!recipientEmail && !walletAddress) return res.status(400).json({ error: 'Provide recipientEmail or walletAddress' });

  const templateId = TEMPLATE_MAP[passType.toUpperCase()];
  const recipient = walletAddress
    ? { walletAddress }
    : { email: recipientEmail };

  const mintPayload = {
    recipient,
    metadata: {
      name: `Aurevon ${passType} Pass`,
      description: `Official Aurevon ${passType} membership pass. On-chain on Base (ETH L2).`,
      image: `https://aurevon-site.vercel.app/nfts/${passType.toLowerCase()}.html`,
      attributes: [
        { trait_type: 'Pass Tier', value: passType },
        { trait_type: 'Network', value: 'Base' },
        { trait_type: 'Issuer', value: 'Aurevon Group LLC' },
        ...(metadata?.attributes || [])
      ]
    }
  };

  // If templates are configured, use template-based minting
  const endpoint = templateId
    ? `https://www.crossmint.com/api/2022-06-09/collections/${CROSSMINT_COLLECTION_ID}/nfts`
    : `https://www.crossmint.com/api/2022-06-09/collections/${CROSSMINT_COLLECTION_ID}/nfts`;

  if (templateId) mintPayload.templateId = templateId;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'X-API-KEY': CROSSMINT_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(mintPayload)
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: 'Crossmint error', detail: data });
    return res.status(200).json({ ok: true, actionId: data.actionId, id: data.id, data });
  } catch (err) {
    return res.status(500).json({ error: 'Mint failed', message: err.message });
  }
}
