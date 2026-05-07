/**
 * Stripe Checkout Session — POST /api/stripe/checkout
 *
 * Vercel serverless function (ESM, Node 20+).
 * Creates a Stripe Checkout Session and redirects the user.
 * Supports all Aurevon product tiers across RE, Web3/NFT verticals.
 */

import Stripe from 'stripe';

// ---------------------------------------------------------------------------
// Product catalog — maps tier keys to Stripe price configs
// ---------------------------------------------------------------------------
const PRODUCT_CATALOG = {
  // Aurevon RE tiers
  re_bogo: {
    name: 'Aurevon RE — First-Timer BOGO',
    description: '2 Full Package deals — underwriting + analysis for 2 properties.',
    amount: 29999, // $299.99
    currency: 'usd',
    mode: 'payment',
    tier: 're_bogo',
  },
  re_single: {
    name: 'Aurevon RE — Second Opinion',
    description: 'Underwriting + analysis report, 2 documents.',
    amount: 18999, // $189.99
    currency: 'usd',
    mode: 'payment',
    tier: 're_single',
  },
  re_full: {
    name: 'Aurevon RE — Full Package',
    description: 'Full underwriting package — all 3 documents.',
    amount: 25000, // $250.00
    currency: 'usd',
    mode: 'payment',
    tier: 're_full',
  },
  re_retainer: {
    name: 'Aurevon RE — Pro Retainer',
    description: '6 deals/month — pro retainer subscription.',
    amount: 149900, // $1,499/mo
    currency: 'usd',
    mode: 'subscription',
    tier: 're_retainer',
  },
  re_enterprise: {
    name: 'Aurevon RE — Enterprise',
    description: 'Unlimited deals/month — enterprise subscription.',
    amount: 249900, // $2,499/mo
    currency: 'usd',
    mode: 'subscription',
    tier: 're_enterprise',
  },
  // Aurevon Web3 / NFT Community tiers
  comm_monthly: {
    name: 'Aurevon NFT — Community Monthly',
    description: 'Monthly NFT Community membership. Includes Discord access + Genesis NFT.',
    amount: 2999, // $29.99/mo
    currency: 'usd',
    mode: 'subscription',
    tier: 'comm_monthly',
  },
  comm_lifetime: {
    name: 'Aurevon NFT — Community Lifetime',
    description: 'Lifetime NFT Community membership. One-time payment. Includes Genesis NFT.',
    amount: 34999, // $349.99
    currency: 'usd',
    mode: 'payment',
    tier: 'comm_lifetime',
  },
};

// ---------------------------------------------------------------------------
// Vercel handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    console.error('[Checkout] STRIPE_SECRET_KEY not set');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  const stripe = new Stripe(stripeSecretKey);

  const { tier, promoCode, cancelPath } = req.body ?? {};

  if (!tier || !PRODUCT_CATALOG[tier]) {
    return res.status(400).json({ error: `Unknown tier: ${tier}` });
  }

  const product = PRODUCT_CATALOG[tier];
  const baseUrl = process.env.BASE_URL || 'https://www.aurevonvc.com';

  // Build success URL — for RE tiers, redirect to intake form with session ID
  let successUrl;
  if (tier.startsWith('re_')) {
    successUrl = `${baseUrl}/AUREVON_RE_Intake.html?paid={CHECKOUT_SESSION_ID}&tier=${tier}`;
  } else {
    successUrl = `${baseUrl}/membership-confirmation?session_id={CHECKOUT_SESSION_ID}&tier=${tier}`;
  }
  const cancelUrl = `${baseUrl}${cancelPath || '/'}`;  

  try {
    const sessionParams = {
      mode: product.mode,
      line_items: [
        {
          price_data: {
            currency: product.currency,
            product_data: {
              name: product.name,
              description: product.description,
              images: [`${baseUrl}/assets/aurevon-logo.png`],
            },
            unit_amount: product.amount,
            ...(product.mode === 'subscription' && {
              recurring: { interval: 'month' },
            }),
          },
          quantity: 1,
        },
      ],
      metadata: { tier: product.tier },
      customer_creation: product.mode === 'payment' ? 'always' : undefined,
      success_url: successUrl,
      cancel_url: cancelUrl,
      // Aurevon branding
      custom_text: {
        submit: { message: 'You will receive your Aurevon delivery via email after payment.' },
      },
      // Allow promo codes entered at checkout
      allow_promotion_codes: true,
      // Collect billing/email details
      billing_address_collection: 'auto',
      phone_number_collection: { enabled: false },
    };

    // Apply pre-filled promo code if provided
    if (promoCode) {
      try {
        const promotionCodes = await stripe.promotionCodes.list({ code: promoCode, active: true, limit: 1 });
        if (promotionCodes.data.length > 0) {
          sessionParams.discounts = [{ promotion_code: promotionCodes.data[0].id }];
          sessionParams.allow_promotion_codes = false; // disable field when pre-filled
        }
      } catch (err) {
        console.warn(`[Checkout] Promo code lookup failed: ${err.message}`);
      }
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    return res.status(200).json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error(`[Checkout] Stripe error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
}
