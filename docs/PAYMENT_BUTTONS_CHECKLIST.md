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
| NFT Insider (standalone) | $497 | ✅ `nft_insider` | ⬜ PayPal standalone link not created |
| NFT Obsidian (standalone) | $997 | ✅ `nft_obsidian` | ⬜ PayPal standalone link not created |
| Web3 Starter/Growth/Scale/Enterprise | $49–$799/mo | ✅ `web3_*` | ⬜ PayPal not created (Stripe-only today) |

---

## À La Carte add-ons — Stripe done, PayPal TO CREATE

For each add-on: (1) confirm the Stripe price exists, (2) create the PayPal NCP link,
(3) paste it into `AUREVON_CONFIG.PAYPAL_ADDON_*_URL` in `aurevon-re.html`.

### 12-Hour Rush Delivery — $99
- [ ] **Stripe** price exists (`api/stripe/checkout.js` → `addon_rush` → `price_1TYzKN8e9ZIjX9wL9IcUXeao`) — verify in Dashboard
- [ ] **PayPal** NCP link created at $99
- [ ] Pasted into `PAYPAL_ADDON_RUSH_URL`

### Investor Memo Formatting — $149
- [ ] **Stripe** `addon_memo` → `price_1TYzKO8e9ZIjX9wLa5AhYOlE` — verify
- [ ] **PayPal** NCP link created at $149
- [ ] Pasted into `PAYPAL_ADDON_MEMO_URL`

### Lender Presentation Package — $199
- [ ] **Stripe** `addon_lender` → `price_1TYzKO8e9ZIjX9wLsSa6KFYu` — verify
- [ ] **PayPal** NCP link created at $199
- [ ] Pasted into `PAYPAL_ADDON_LENDER_URL`

### Sensitivity Modeling — $125
- [ ] **Stripe** `addon_sensitivity` → `price_1TYzKP8e9ZIjX9wLHDbMDWou` — verify
- [ ] **PayPal** NCP link created at $125
- [ ] Pasted into `PAYPAL_ADDON_SENSITIVITY_URL`

### Portfolio Review Bundle — $499
- [ ] **Stripe** `addon_portfolio` → `price_1TYzKP8e9ZIjX9wLP71oZzcQ` — verify
- [ ] **PayPal** NCP link created at $499
- [ ] Pasted into `PAYPAL_ADDON_PORTFOLIO_URL`

### White-Label Reports — $175/deal
- [ ] **Stripe** `addon_whitelabel` → `price_1TYzKQ8e9ZIjX9wLrymffEFh` — verify
- [ ] **PayPal** NCP link created at $175
- [ ] Pasted into `PAYPAL_ADDON_WHITELABEL_URL`

> Until a `PAYPAL_ADDON_*_URL` is filled in, the page hides that add-on's PayPal button
> automatically (no dead buttons). The Stripe "Card" button works regardless.
> The server-side `PASS_PRICES` in `api/paypal/index.js` already has matching add-on
> amounts, so PayPal capture/logging works once the link is live.

---

## Discrepancies flagged during the audit (decide before launch)

- [ ] **PayPal `PASS_PRICES.INSIDER` = $250** but standalone NFT Insider is **$497** (Stripe `nft_insider`). Decide whether PayPal sells the bundled ($250) or standalone ($497) Insider — they currently differ.
- [ ] **PayPal `PASS_PRICES.GENESIS` = $500 "Founder Pass"** has no Stripe equivalent (Stripe Genesis = `comm_monthly` $29.99). Confirm this $500 product is intentional or remove it.
- [ ] **PayPal `PASS_PRICES.OBSIDIAN` = $2,499** (Enterprise) — no standalone $997 Obsidian on PayPal to mirror Stripe `nft_obsidian`.
- [ ] **Web3 subscription tiers** are Stripe-only — create PayPal subscription plans if you want them mirrored.

---

## Test before go-live
- [ ] Stripe test card `4242 4242 4242 4242` works for one tier + one add-on
- [ ] PayPal sandbox checkout completes for one tier + one add-on
- [ ] Webhook fires and a Payments row appears in Airtable for both processors
- [ ] Confirmation email arrives with the correct friendly add-on label
