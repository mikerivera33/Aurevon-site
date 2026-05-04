# Aurevon — Owner QA Checklist

> Print this document and check off each item before going live and after every major deployment.
> Date: ________________  Checked by: ________________  Deployment: ________________

---

## A. Visual / Load Checks

| # | Check | Status | Notes |
|---|---|---|---|
| A01 | `index.html` loads without blank screen | [ ] | |
| A02 | `BLOCKT_Web3.html` loads without blank screen | [ ] | |
| A03 | `BLOCKT_NFT_Collection.html` loads without blank screen | [ ] | |
| A04 | `001_Genesis.html` loads without blank screen | [ ] | |
| A05 | `004_Chrome.html` loads without blank screen | [ ] | |
| A06 | `BLOCKT_RE_Final.html` loads without blank screen | [ ] | |
| A07 | `BLOCKT_RE_Intake.html` loads without blank screen | [ ] | |
| A08 | `membership_confirmation.html` loads without blank screen | [ ] | |
| A09 | `operator.html` loads without blank screen | [ ] | |
| A10 | Custom fonts load (not falling back to system font) | [ ] | |
| A11 | Hero image on `index.html` loads | [ ] | |
| A12 | NFT artwork images load on `BLOCKT_NFT_Collection.html` | [ ] | |
| A13 | Tier card images load on all pages | [ ] | |
| A14 | Logo in header renders correctly | [ ] | |
| A15 | No broken image icons (alt text showing instead of image) | [ ] | |
| A16 | No JavaScript console errors on any page (F12 → Console) | [ ] | |
| A17 | No 404 errors in Network tab on any page | [ ] | |

---

## B. Navigation

| # | Check | Status | Notes |
|---|---|---|---|
| B01 | Header nav links on `index.html` all work | [ ] | |
| B02 | Footer links on `index.html` all work | [ ] | |
| B03 | "Join Now" / CTA buttons link to correct tier checkout | [ ] | |
| B04 | Navigation from `index.html` to `BLOCKT_Web3.html` works | [ ] | |
| B05 | Navigation from `index.html` to `BLOCKT_RE_Final.html` works | [ ] | |
| B06 | Navigation from `BLOCKT_Web3.html` back to `index.html` works | [ ] | |
| B07 | `001_Genesis.html` and `004_Chrome.html` have back navigation | [ ] | |
| B08 | `membership_confirmation.html` links to Discord invite | [ ] | |
| B09 | No dead links (404) anywhere on any page | [ ] | |
| B10 | Browser back button works after all navigations | [ ] | |

---

## C. Payment Flow — Each Tier

Test each tier's payment flow. For Stripe: use test card `4242 4242 4242 4242`, exp `12/29`, CVC `123`.

| # | Check | Status | Notes |
|---|---|---|---|
| C01 | **Insider ($297)** — correct amount shown on page | [ ] | |
| C02 | **Insider** — Stripe checkout opens with correct price | [ ] | |
| C03 | **Insider** — all 4 payment methods visible: Card, Cash App, Afterpay, PayPal | [ ] | |
| C04 | **Ember ($497)** — correct amount shown | [ ] | |
| C05 | **Ember** — Stripe checkout opens with correct price | [ ] | |
| C06 | **Obsidian Executive ($997)** — correct amount shown | [ ] | |
| C07 | **Obsidian Executive** — Stripe checkout opens with correct price | [ ] | |
| C08 | **001 Genesis ($2,497)** — correct amount shown | [ ] | |
| C09 | **001 Genesis** — Stripe checkout opens with correct price | [ ] | |
| C10 | **004 Chrome ($4,997)** — correct amount shown | [ ] | |
| C11 | **004 Chrome** — Stripe checkout opens with correct price | [ ] | |
| C12 | **RE Pro Retainer ($2,500/mo)** — correct amount shown | [ ] | |
| C13 | **RE Enterprise ($5,000/mo)** — correct amount shown | [ ] | |
| C14 | Test purchase of **Insider** tier completes successfully | [ ] | |
| C15 | After test purchase, redirected to `membership_confirmation.html` | [ ] | |
| C16 | PayPal button visible as alternative payment on each tier | [ ] | |

---

## D. Intake Form Gating

| # | Check | Status | Notes |
|---|---|---|---|
| D01 | Visiting `BLOCKT_RE_Intake.html` directly shows the gate/lock | [ ] | |
| D02 | Gate cannot be bypassed by inspecting HTML (form is hidden) | [ ] | |
| D03 | Correct unlock mechanism works (password, link, or membership check) | [ ] | |
| D04 | After unlocking, the full intake form is visible | [ ] | |
| D05 | All form fields are present: Name, Email, Phone, Service, Message | [ ] | |
| D06 | Required field validation works (cannot submit blank form) | [ ] | |
| D07 | Email field validates email format | [ ] | |
| D08 | Submitting valid form shows success message | [ ] | |
| D09 | After submission, a new row appears in Airtable Leads table | [ ] | |
| D10 | Airtable row has correct: name, email, phone, service, message | [ ] | |

---

## E. NFT Delivery

| # | Check | Status | Notes |
|---|---|---|---|
| E01 | Stripe test webhook fires after test purchase | [ ] | |
| E02 | Webhook returns HTTP 200 in Stripe dashboard | [ ] | |
| E03 | Airtable Payments table shows new row within 30s | [ ] | |
| E04 | Crossmint mint is triggered (check Crossmint console) | [ ] | |
| E05 | Airtable NFT_Mints table shows new row | [ ] | |
| E06 | NFT_Mints row status changes from `pending` to `minted` within 60s | [ ] | |
| E07 | Confirmation email arrives in test inbox within 60s | [ ] | |
| E08 | Email contains the customer's NFT metadata (tier, token ID) | [ ] | |
| E09 | Email contains Discord invite link | [ ] | |
| E10 | Discord invite link is functional (not expired) | [ ] | |

---

## F. Discord OAuth Flow

| # | Check | Status | Notes |
|---|---|---|---|
| F01 | Clicking Discord invite link from email opens Discord OAuth page | [ ] | |
| F02 | OAuth page shows correct bot name and server | [ ] | |
| F03 | OAuth page shows correct permissions requested | [ ] | |
| F04 | Authorizing redirects back to `membership_confirmation.html` | [ ] | |
| F05 | Correct Discord role is assigned (e.g., Insider role for Insider tier) | [ ] | |
| F06 | No incorrect roles assigned (Ember member should not have Chrome role) | [ ] | |
| F07 | Airtable Members row shows `discord_joined = true` | [ ] | |
| F08 | Airtable Members row has `discord_id` populated | [ ] | |
| F09 | Welcome message posted in correct Discord channel | [ ] | |

---

## G. Operator Hub

| # | Check | Status | Notes |
|---|---|---|---|
| G01 | `operator.html` prompts for Airtable PAT on first load | [ ] | |
| G02 | Entering a valid PAT loads data successfully | [ ] | |
| G03 | **Total Revenue** KPI tile shows correct dollar value | [ ] | |
| G04 | **Active Members** KPI tile shows correct count | [ ] | |
| G05 | **Pending Mints** KPI tile shows correct count | [ ] | |
| G06 | **New Leads (7d)** KPI tile shows correct count | [ ] | |
| G07 | Leads table populates with data from Airtable | [ ] | |
| G08 | Leads table shows: name, email, service, status, date | [ ] | |
| G09 | NFT Mint Log populates with mint records | [ ] | |
| G10 | Mint Log status badges render (green=minted, yellow=pending, red=failed) | [ ] | |
| G11 | Payments Feed populates with recent payments | [ ] | |
| G12 | "Refresh" button reloads data without page reload | [ ] | |
| G13 | Auto-refresh fires every 60 seconds (check by watching KPI tiles) | [ ] | |
| G14 | "Retry" button on failed mints calls `/api/cron/retry-mints` | [ ] | |
| G15 | "Change PAT" button allows updating the stored token | [ ] | |

---

## H. Mobile Rendering

Test at 390px width (iPhone 14) and 768px (iPad).

| # | Check | Status | Notes |
|---|---|---|---|
| H01 | `index.html` renders without horizontal scroll at 390px | [ ] | |
| H02 | Navigation is collapsed into hamburger menu on mobile | [ ] | |
| H03 | Hamburger menu opens and closes correctly | [ ] | |
| H04 | Tier cards stack vertically on mobile (not cut off) | [ ] | |
| H05 | CTA buttons are tappable (at least 44px height) | [ ] | |
| H06 | Stripe checkout modal is usable on mobile | [ ] | |
| H07 | Intake form fields are usable on mobile keyboard | [ ] | |
| H08 | Operator Hub is readable (not just desktop layout squeezed) | [ ] | |
| H09 | All pages render at 768px (iPad) without issues | [ ] | |
| H10 | No text overflows its container on any mobile width | [ ] | |

---

## I. Performance

| # | Check | Status | Notes |
|---|---|---|---|
| I01 | `index.html` Lighthouse performance score >= 90 | [ ] | |
| I02 | `BLOCKT_Web3.html` Lighthouse score >= 90 | [ ] | |
| I03 | `BLOCKT_RE_Final.html` Lighthouse score >= 90 | [ ] | |
| I04 | Images are compressed (no raw 5MB+ images) | [ ] | |
| I05 | Page loads in < 3 seconds on a 4G connection (Lighthouse) | [ ] | |
| I06 | No render-blocking scripts in `<head>` | [ ] | |

---

## J. SEO & Meta Tags

| # | Check | Status | Notes |
|---|---|---|---|
| J01 | `index.html` has `<meta name="description">` tag | [ ] | |
| J02 | `index.html` has Open Graph tags (`og:title`, `og:description`, `og:image`) | [ ] | |
| J03 | `index.html` has Twitter Card meta tags | [ ] | |
| J04 | All pages have unique `<title>` tags | [ ] | |
| J05 | OG image is at least 1200×630px | [ ] | |
| J06 | `sitemap.xml` exists at `/sitemap.xml` (if applicable) | [ ] | |
| J07 | `robots.txt` exists and does not block `/api/` | [ ] | |
| J08 | `operator.html` is excluded from indexing (`noindex` meta or robots.txt) | [ ] | |

---

## K. Security & Legal

| # | Check | Status | Notes |
|---|---|---|---|
| K01 | SSL certificate is active (green padlock in browser) | [ ] | |
| K02 | HTTP redirects to HTTPS (test `http://yourdomain.com`) | [ ] | |
| K03 | CSP header present (`Content-Security-Policy` in response headers) | [ ] | |
| K04 | `X-Frame-Options: SAMEORIGIN` header present | [ ] | |
| K05 | No API keys exposed in client-side HTML or JavaScript | [ ] | |
| K06 | `.env` file is not accessible at `https://yourdomain.com/.env` | [ ] | |
| K07 | Financial disclaimer present in footer of all relevant pages | [ ] | See note below |
| K08 | Privacy Policy link in footer | [ ] | |
| K09 | Terms of Service link in footer | [ ] | |
| K10 | Cookie consent banner (if applicable for your jurisdiction) | [ ] | |

**Financial Disclaimer note:** All pages discussing investment returns, membership benefits tied to financial outcomes, or deal flow must include: *"Aurevon does not provide financial, legal, or investment advice. Past performance is not indicative of future results. All investments carry risk."*

---

## L. Post-Purchase Flow (End-to-End)

Run this as a complete end-to-end test using real credentials before going live.

| # | Check | Status | Notes |
|---|---|---|---|
| L01 | Customer visits site and selects Insider tier | [ ] | |
| L02 | Completes Stripe payment with test card | [ ] | |
| L03 | Receives redirect to `membership_confirmation.html` | [ ] | |
| L04 | Receives confirmation email within 60 seconds | [ ] | |
| L05 | Email has correct tier name and NFT details | [ ] | |
| L06 | Clicks Discord link → OAuth flow completes | [ ] | |
| L07 | Correct Discord role assigned | [ ] | |
| L08 | Operator Hub shows new payment, mint, and member record | [ ] | |
| L09 | Entire flow took < 5 minutes | [ ] | |

---

**Checklist completed:** ________________  
**Total items checked:** _____ / 80  
**Issues found:** ________________  
**Signed off by:** ________________
