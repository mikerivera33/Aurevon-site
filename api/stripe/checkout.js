/**
 * Stripe Checkout Session — POST /api/stripe/checkout
 *
 * Vercel serverless function (ESM, Node 20+).
 * Creates a Stripe Checkout Session and redirects the user.
 * Supports all Aurevon product tiers across RE, Web3/NFT verticals.
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
  },
  re_single: {
    name: 'Aurevon RE — Second Opinion',
    priceId: 'price_1TUbRV8e9ZIjX9wLwnipS9cT',
    mode: 'payment',
    tier: 're_single',
  },
  re_full: {
    name: 'Aurevon RE — Full Package',
    priceId: 'price_1TUbRq8e9ZIjX9wLmheDhC9n',
    mode: 'payment',
    tier: 're_full',
  },
  re_retainer: {
    name: 'Aurevon RE — Pro Retainer',
    priceId: 'price_1TUbSQ8e9ZIjX9wL2eaJG23q',
    mode: 'subscription',
    tier: 're_retainer',
  },
  re_enterprise: {
    name: 'Aurevon RE — Enterprise',
    priceId: 'price_1TUbUa8e9ZIjX9wLKzmvxCni',
    mode: 'subscription',
    tier: 're_enterprise',
  },
  // Aurevon Web3 / AI tiers
  web3_starter: {
    name: 'Aurevon Web3 — Starter',
    priceId: 'price_1TUbWM8e9ZIjX9wL1rvz5qpC',
    mode: 'subscription',
    tier: 'web3_starter',
  },
  web3_growth: {
    name: 'Aurevon Web3 — Growth',
    priceId: 'price_1TUbWw8e9ZIjX9wLkSdG65AA',
    mode: 'subscription',
    tier: 'web3_growth',
  },
  web3_scale: {
    name: 'Aurevon Web3 — Scale',
    priceId: 'price_1TUbXO8e9ZIjX9wLWcv9ckWi',
    mode: 'subscription',
    tier: 'web3_scale',
  },
  web3_enterprise: {
    name: 'Aurevon Web3 — Enterprise',
    priceId: 'price_1TUbXi8e9ZIjX9wL1UllvSGy',
    mode: 'subscription',
    tier: 'web3_enterprise',
  },
  // Aurevon Community tiers
  comm_monthly: {
    name: 'Aurevon Community — Monthly Membership',
    priceId: process.env.STRIPE_PRICE_COMM_MONTHLY ?? '',
    mode: 'subscription',
    tier: 'comm_monthly',
  },
  comm_lifetime: {
    name: 'Aurevon Community — Lifetime Membership (001 Genesis Pass)',
    priceId: process.env.STRIPE_PRICE_COMM_LIFETIME ?? '',
    mode: 'payment',
    tier: 'comm_lifetime',
  },
};

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

  const BASE_URL = process.env.BASE_URL;
  if (!BASE_URL) return res.status(500).json({ error: 'BASE_URL not configured — contact support' });

  try {
    const sessionParams = {
      mode: product.mode,
      line_items: [
        {
          price: product.priceId,
          quantity: 1,
        },
      ],
      success_url: `${BASE_URL}/success?tier=${product.tier}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/cancel?tier=${product.tier}`,
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
