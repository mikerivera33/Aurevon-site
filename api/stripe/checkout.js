/**
 * Stripe Checkout Session — POST /api/stripe/checkout
 *
 * Vercel serverless function (ESM, Node 20+).
 * Creates a Stripe Checkout Session and redirects the user.
 * Supports all Aurevon product tiers across RE, Web3/NFT verticals.
 *
 * Success URL format:
 *  Community tiers → /success?paid=paid_{tier}_{CHECKOUT_SESSION_ID}&tier={tier}&amount={amount}
 *  RE/NFT tiers    → /aurevon-re?purchased={tier}&session_id={CHECKOUT_SESSION_ID}
 *
 * The membership_confirmation.html gate checks: paid param starts with "paid_"
 * Stripe replaces {CHECKOUT_SESSION_ID} with the real session ID at redirect time.
 */

import Stripe from 'stripe';

// -----------------------------------------------------------------------
// Product catalog — maps tier keys to real Stripe price IDs (Aurevon-Labs)
// -----------------------------------------------------------------------
const PRODUCT_CATALOG = {
      // Aurevon RE tiers
      re_bogo: {
              name: 'Aurevon RE — First-Timer BOGO',
              priceId: 'price_1TUbS78e9ZIjX9wLXztOF2rW',
              mode: 'payment',
              tier: 're_bogo',
              amount: '299.99',
      },
      re_single: {
              name: 'Aurevon RE — Second Opinion',
              priceId: 'price_1TUbRV8e9ZIjX9wLwnipS9cT',
              mode: 'payment',
              tier: 're_single',
              amount: '189.99',
      },
      re_full: {
              name: 'Aurevon RE — Full Package',
              priceId: 'price_1TUbRq8e9ZIjX9wLmheDhC9n',
              mode: 'payment',
              tier: 're_full',
              amount: '250.00',
      },
      re_retainer: {
              name: 'Aurevon RE — Pro Retainer',
              priceId: 'price_1TUbSQ8e9ZIjX9wL2eaJG23q',
              mode: 'subscription',
              tier: 're_retainer',
              amount: '1499.00',
      },
      re_enterprise: {
              name: 'Aurevon RE — Enterprise',
              priceId: 'price_1TUbUa8e9ZIjX9wLKzmvxCni',
              mode: 'subscription',
              tier: 're_enterprise',
              amount: '2499.00',
      },
      // Aurevon Web3 / AI tiers
      web3_starter: {
              name: 'Aurevon Web3 — Starter',
              priceId: 'price_1TUbWM8e9ZIjX9wL1rvz5qpC',
              mode: 'subscription',
              tier: 'web3_starter',
              amount: '49.00',
      },
      web3_growth: {
              name: 'Aurevon Web3 — Growth',
              priceId: 'price_1TUbWw8e9ZIjX9wLkSdG65AA',
              mode: 'subscription',
              tier: 'web3_growth',
              amount: '149.00',
      },
      web3_scale: {
              name: 'Aurevon Web3 — Scale',
              priceId: 'price_1TUbXO8e9ZIjX9wLWcv9ckWi',
              mode: 'subscription',
              tier: 'web3_scale',
              amount: '349.00',
      },
      web3_enterprise: {
              name: 'Aurevon Web3 — Enterprise',
              priceId: 'price_1TUbXi8e9ZIjX9wL1UllvSGy',
              mode: 'subscription',
              tier: 'web3_enterprise',
              amount: '799.00',
      },
      // Aurevon Community tiers
      comm_monthly: {
              name: 'Aurevon Labs — Genesis Community Pass',
              priceId: 'price_1TUemd8e9ZIjX9wLnuEZDWjd',
              mode: 'subscription',
              tier: 'comm_monthly',
              amount: '29.99',
      },
      comm_lifetime: {
              name: 'Aurevon Labs — Chrome Lifetime Pass',
              priceId: 'price_1TUen68e9ZIjX9wLvMNuoXGJ',
              mode: 'payment',
              tier: 'comm_lifetime',
              amount: '349.99',
      },
      // Aurevon RE — À La Carte Add-Ons
      addon_rush: {
              name: 'Aurevon RE — 12-Hour Rush Delivery',
              priceId: 'price_1TYzKN8e9ZIjX9wL9IcUXeao',
              mode: 'payment',
              tier: 'addon_rush',
              amount: '99.00',
      },
      addon_memo: {
              name: 'Aurevon RE — Investor Memo Formatting',
              priceId: 'price_1TYzKO8e9ZIjX9wLa5AhYOlE',
              mode: 'payment',
              tier: 'addon_memo',
              amount: '149.00',
      },
      addon_lender: {
              name: 'Aurevon RE — Lender Presentation Package',
              priceId: 'price_1TYzKO8e9ZIjX9wLsSa6KFYu',
              mode: 'payment',
              tier: 'addon_lender',
              amount: '199.00',
      },
      addon_sensitivity: {
              name: 'Aurevon RE — Sensitivity Modeling',
              priceId: 'price_1TYzKP8e9ZIjX9wLHDbMDWou',
              mode: 'payment',
              tier: 'addon_sensitivity',
              amount: '125.00',
      },
      addon_portfolio: {
              name: 'Aurevon RE — Portfolio Review Bundle',
              priceId: 'price_1TYzKP8e9ZIjX9wLP71oZzcQ',
              mode: 'payment',
              tier: 'addon_portfolio',
              amount: '499.00',
      },
      addon_whitelabel: {
              name: 'Aurevon RE — White-Label Reports',
              priceId: 'price_1TYzKQ8e9ZIjX9wLrymffEFh',
              mode: 'payment',
              tier: 'addon_whitelabel',
              amount: '175.00',
      },
};

// Community tiers land on confirmation page; all others return to RE/NFT page
const COMMUNITY_TIERS = new Set(['comm_monthly', 'comm_lifetime']);
const WEB3_TIERS = new Set(['web3_starter', 'web3_growth', 'web3_scale', 'web3_enterprise']);
const NFT_TIERS = new Set();

// -----------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------
export default async function handler(req, res) {
      if (req.method !== 'POST') {
              return res.status(405).json({ error: 'Method not allowed' });
      }

  const { tier } = req.body ?? {};

  if (!tier) {
          return res.status(400).json({ error: 'Missing tier parameter' });
  }

  const product = PRODUCT_CATALOG[tier];
      if (!product) {
              return res.status(400).json({ error: `Unknown tier: ${tier}` });
      }

  if (product.priceId === '') {
          return res.status(503).json({ error: 'This product is not yet configured — contact support.' });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
          return res.status(500).json({ error: 'Stripe secret key not configured' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
          apiVersion: '2023-10-16',
  });

  // Resolve site base URL — VERCEL_URL is auto-set by Vercel on every deployment
  const BASE_URL = process.env.BASE_URL
        || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
        || 'https://aurevon-site.vercel.app';

  try {
          let successUrl, cancelUrl;

        if (COMMUNITY_TIERS.has(product.tier)) {
                  // Community (Genesis/Chrome): land on membership confirmation page
            // paid=paid_{tier}_{CHECKOUT_SESSION_ID} satisfies the gate check (starts with "paid_")
            // Stripe replaces {CHECKOUT_SESSION_ID} at redirect time
            successUrl = `${BASE_URL}/success?paid=paid_${product.tier}_{CHECKOUT_SESSION_ID}&tier=${product.tier}&amount=${product.amount}`;
                  cancelUrl = `${BASE_URL}/cancel`;
        } else if (WEB3_TIERS.has(product.tier)) {
            successUrl = `${BASE_URL}/aurevon-web3?purchased=${product.tier}&session_id={CHECKOUT_SESSION_ID}`;
                  cancelUrl = `${BASE_URL}/aurevon-web3`;
        } else if (NFT_TIERS.has(product.tier)) {
            successUrl = `${BASE_URL}/aurevon-nft?purchased=${product.tier}&session_id={CHECKOUT_SESSION_ID}`;
                  cancelUrl = `${BASE_URL}/aurevon-nft`;
        } else {
                  // RE tiers and add-ons
            successUrl = `${BASE_URL}/aurevon-re?purchased=${product.tier}&session_id={CHECKOUT_SESSION_ID}`;
                  cancelUrl = `${BASE_URL}/aurevon-re`;
        }

        const sessionParams = {
                  mode: product.mode,
                  line_items: [
                      {
                                    price: product.priceId,
                                    quantity: 1,
                      },
                            ],
                  success_url: successUrl,
                  cancel_url: cancelUrl,
                  metadata: {
                              tier: product.tier,
                              product_name: product.name,
                  },
        };

        if (req.body?.email) sessionParams.customer_email = req.body.email;

        const session = await stripe.checkout.sessions.create(sessionParams);
          return res.status(200).json({ url: session.url });
  } catch (err) {
          console.error('Stripe checkout error:', err.message);
          return res.status(500).json({ error: err.message });
  }
}
