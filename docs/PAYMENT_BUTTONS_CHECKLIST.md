# Aurevon — Payment Buttons Checklist (Stripe + PayPal)

This tracks every purchasable item and whether it has a **Stripe** and a **PayPal**
button, so the two processors stay mirrored. Check a box once the product/price/link
exists in that platform's dashboard **and** the ID/link is wired in the repo.

---

## Where each value goes in the repo

| Value | File | What it is |
|---|---|---|
| Stripe `priceId` (tiers + add-ons) | `api/stripe/checkout.js` → `TIER_PRODUCTS` | `price_…` from Stripe Dashboard → Product → Price |
| Stripe checkout call | already wired — buttons POST `tier` to `/api/stripe/checkout` | no per-button URL needed |
| PayPal tier links (main 5) | `aurevon-re.html` → `AUREVON_CONFIG.PAYPAL_*_URL` | NCP link `https://www.paypal.com/ncp/payment/XXXX` |
| **PayPal add-on links (new)** | `aurevon-re.html` → `AUREVON_CONFIG.PAYPAL_ADDON_*_URL` | NCP link per add-on (empty = button auto-hides) |
| PayPal API amounts (web3/nft + add-ons) | `api/paypal/index.js` → `PASS_PRICES` | server-side amount/description map |
| Crossmint template/collection IDs | Vercel env (`CROSSMINT_*`) | not a button — drives the minted NFT |

> **Stripe** needs only a Product + Price; the site calls `/api/stripe/checkout` with the
> tier key, so you never paste a Stripe URL into the page.
> **PayPal** uses hosted **NCP payment links** (PayPal Business → Pay & Get Paid → PayPal
> buttons / payment links), which must be created by hand and pasted into the config.

---

## Core tiers — already mirrored ✅

| Tier | Price | Stripe (`checkout.js` priceId) | PayPal (`PAYPAL_*_URL`) |
|---|---|---|---|
| First-Timer BOGO | $299.99 | ✅ `re_bogo` | ✅ set |
| Second Opinion | $189.99 | ✅ `re_single` | ✅ set |
| Full Package | $250.00 | ✅ `re_full` | ✅ set |
| Pro Retainer | $1,499/mo | ✅ `re_retainer` (subscription) | ✅ set |
| Enterprise | $2,499/mo | ✅ `re_enterprise` (subscription) | ✅ set |
| Community Monthly (001 Genesis) | $29.99/mo | ✅ `comm_monthly` | ⚠️ verify `PAYPAL_COMM_MONTHLY_URL` exists on web3/nft page |
| Community Lifetime (004 Chrome) | $349.99 | ✅ `comm_lifetime` | ⚠️ verify `PAYPAL_COMM_LIFETIME_URL` |
| Web3 Starter/Growth/Scale/Enterprise | $49–$799/mo | ✅ `web3_*` | ⬜ PayPal not created (Stripe-only today) |

---

## À La Carte add-ons — Stripe done · PayPal Cart wired ✅

Each add-on row now offers two payment paths:
- **"Card"** — Stripe checkout-session (single item per checkout). Already live; backed by `priceId` in `api/stripe/checkout.js`.
- **"Add to Cart"** — PayPal NCP Cart widget (`merchant-id=PPMXBVG74GD22`), so customers can stack multiple add-ons into one PayPal checkout. The cart.js script loads once in the add-ons section; a `<paypal-cart-button id="pp-view-cart">` sits above the table.

| Add-on | Price | Stripe `priceId` (verify in Dashboard) | PayPal cart item ID |
|---|---|---|---|
| 12-Hour Rush Delivery | $99 | `price_1TYzKN8e9ZIjX9wL9IcUXeao` (`addon_rush`) | `ET2JQJ4VBMARU` |
| Investor Memo Formatting | $149 | `price_1TYzKO8e9ZIjX9wLa5AhYOlE` (`addon_memo`) | `TTTPPSEEYKWXN` |
| Lender Presentation Package | $199 | `price_1TYzKO8e9ZIjX9wLsSa6KFYu` (`addon_lender`) | `L589RF6C87SJ8` |
| Sensitivity Modeling | $125 | `price_1TYzKP8e9ZIjX9wLHDbMDWou` (`addon_sensitivity`) | `5MU9ZQVBHM2QQ` |
| Portfolio Review Bundle | $499 | `price_1TYzKP8e9ZIjX9wLP71oZzcQ` (`addon_portfolio`) | `4LZVLKSLU34G6` |
| White-Label Reports | $175/deal | `price_1TYzKQ8e9ZIjX9wLrymffEFh` (`addon_whitelabel`) | `Y4ADTAE7FPDW8` |

- [ ] Confirm all 6 Stripe prices exist in the live Dashboard (MCP tested `addon_rush` $99 successfully).
- [ ] Confirm the 6 PayPal cart item IDs above are mapped to the correct products in PayPal Merchant → NCP Cart products (the mapping above is in on-page row order).
- [ ] Sandbox test: add 2 items to cart → click "View Cart" → checkout completes → Airtable Payments row appears.

---

## Discrepancies flagged during the audit (decide before launch)

- [ ] **PayPal `PASS_PRICES.GENESIS` = $500 "Founder Pass"** has no Stripe equivalent (Stripe Genesis = `comm_monthly` $29.99). Confirm this $500 product is intentional or remove it.
- [ ] **Web3 subscription tiers** are Stripe-only — create PayPal subscription plans if you want them mirrored.

---

## Test before go-live
- [ ] Stripe test card `4242 4242 4242 4242` works for one tier + one add-on
- [ ] PayPal sandbox checkout completes for one tier + one add-on
- [ ] Webhook fires and a Payments row appears in Airtable for both processors
- [ ] Confirmation email arrives with the correct friendly add-on label
