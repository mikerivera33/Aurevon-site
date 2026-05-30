# Aurevon — Automation Playbooks

> Detailed Zapier / Make.com recipes for the 8 automation playbooks shown in the Operator Hub.
> Each playbook is self-contained: trigger, actions, field mappings, and links to templates.

---

## Playbook 1: New Lead → Slack Alert

**Purpose:** Get notified immediately when a real estate intake form is submitted so you can follow up within minutes.

**Platform:** Zapier (or Make.com)

### Trigger
- **App:** Airtable
- **Event:** New Record in View
- **Base:** Aurevon
- **Table:** Leads
- **View:** "New Leads" (create this view with filter: `status = new`, sorted by `created_at DESC`)

### Actions

**Action 1 — Send Slack Message**
- **App:** Slack
- **Event:** Send Channel Message
- **Channel:** `#new-leads` (create this channel)
- **Message template:**
  ```
  New AUREVON CAPITAL Lead!
  Name: {{Name}}
  Email: {{Email}}
  Phone: {{Phone}}
  Service: {{Service}}
  Message: {{Message}}
  Time: {{created_at}}
  
  View in Airtable: https://airtable.com/YOUR_BASE_ID/tblXXXX/viwXXXX/{{Record ID}}
  ```

**Action 2 — Update Airtable Status**
- **App:** Airtable
- **Event:** Update Record
- **Table:** Leads
- **Record ID:** `{{Record ID}}` from trigger
- **Field:** `status` → `notified`

### Field Mappings
| Airtable Field | Slack Template Variable |
|---|---|
| `name` | `{{Name}}` |
| `email` | `{{Email}}` |
| `phone` | `{{Phone}}` |
| `service` | `{{Service}}` |
| `message` | `{{Message}}` |
| `created_at` | `{{created_at}}` |

### Zapier Template
Search for "Airtable + Slack New Record" at https://zapier.com/apps/airtable/integrations/slack

### Make.com Equivalent
Trigger: Airtable → Watch Records → Leads table  
Module 1: Slack → Create a Message  
Module 2: Airtable → Update a Record  

---

## Playbook 2: Payment Confirmed → Trigger NFT Mint

**Purpose:** Backup automation in case the primary webhook fails. Watches Airtable Payments for new `completed` records and triggers the mint if not already minted.

**Note:** The primary mint flow is already automated via the Stripe/PayPal webhook → Crossmint API chain. This playbook is a safety net.

**Platform:** Zapier

### Trigger
- **App:** Airtable
- **Event:** New Record in View
- **Table:** Payments
- **View:** "Completed, Not Minted" (filter: `status = completed` AND `mint_triggered` is unchecked)

### Filter (Zapier filter step)
- Only continue if `mint_triggered` is false/empty
- This prevents double minting

### Actions

**Action 1 — Check NFT_Mints Table**
- **App:** Airtable
- **Event:** Search Records
- **Table:** NFT_Mints
- **Search field:** `payment_id`
- **Search value:** `{{payment_id}}` from trigger

**Action 2 — (Only if no existing mint) HTTP POST to /api/crossmint/mint**
- **App:** Webhooks by Zapier (or Make.com HTTP module)
- **URL:** `https://aurevonvc.com/api/crossmint/mint`
- **Method:** POST
- **Headers:** `Content-Type: application/json`, `Authorization: Bearer {{INTERNAL_API_SECRET}}`
- **Body:**
  ```json
  {
    "email": "{{email}}",
    "tier": "{{tier}}",
    "payment_id": "{{payment_id}}",
    "amount": "{{amount}}"
  }
  ```

**Action 3 — Mark mint_triggered in Payments table**
- **App:** Airtable
- **Event:** Update Record
- **Field:** `mint_triggered` → `true`

### Field Mappings
| Payment Field | Mint Request Field |
|---|---|
| `email` | `email` |
| `tier` | `tier` |
| `payment_id` | `payment_id` |
| `amount` | `amount` |

---

## Playbook 3: SLA Breach — Deal Pending > 24 Hours → Email Owner

**Purpose:** Alert you if a lead has been sitting in "new" or "contacted" status for more than 24 hours without being moved to "qualified" or "closed."

**Platform:** Zapier (requires a scheduled trigger)

### Trigger
- **App:** Schedule by Zapier
- **Event:** Every 1 Hour

### Actions

**Action 1 — Search Airtable for Stale Leads**
- **App:** Airtable
- **Event:** Search Records
- **Table:** Leads
- **Formula:** `AND(OR({status}="new",{status}="contacted"), DATETIME_DIFF(NOW(),{created_at},"hours")>24)`

**Action 2 — (Only if records found) Send Email via Resend**
- **App:** Webhooks by Zapier
- **URL:** Resend API `https://api.resend.com/emails`
- **Method:** POST
- **Headers:** `Authorization: Bearer {{RESEND_API_KEY}}`, `Content-Type: application/json`
- **Body:**
  ```json
  {
    "from": "mike@aurevonvc.com",
    "to": ["mike@aurevonvc.com"],
    "subject": "SLA Breach: {{count}} leads pending > 24h",
    "html": "<p>The following leads have been pending for more than 24 hours:</p><ul>{{#each records}}<li>{{name}} — {{service}} — {{created_at}}</li>{{/each}}</ul><p>Log in to Operator Hub to take action.</p>"
  }
  ```

### Make.com Version
Use an iterator to loop over all stale leads and build a summary table in one email.

### SLA Configuration
Adjust the `24` hour threshold in the Airtable formula to match your desired response time.

---

## Playbook 4: New 5-Star Review → Request Testimonial

**Purpose:** When a member submits a 5-star review (tracked in Airtable or via a third-party review tool), automatically send a request for a written testimonial to use in marketing.

**Platform:** Zapier

### Trigger
- **App:** Airtable
- **Event:** New Record in View
- **Table:** Members
- **View:** "5-Star Reviews" (filter: `nps_score >= 9` or `review_rating = 5`)

### Actions

**Action 1 — Wait 1 Hour**
- **App:** Delay by Zapier
- **Duration:** 1 hour
- (Gives member time to feel good before asking for more)

**Action 2 — Send Testimonial Request Email**
- **App:** Webhooks by Zapier → Resend API
- **Template:**
  ```
  Subject: Thank you for the 5 stars, {{first_name}}!

  Hi {{first_name}},

  We saw your amazing review — that genuinely made our day.

  Would you be open to sharing a short written testimonial we could feature on the Aurevon website? It would mean a lot to us and help other investors find the community.

  Just reply to this email with 2–4 sentences about your experience. We'll handle the rest.

  Thank you again for being a {{tier}} member.

  — The Aurevon Team
  ```

**Action 3 — Update Airtable**
- Mark `testimonial_requested = true` on the Members record

### Field Mappings
| Members Field | Email Template |
|---|---|
| `name` (split to first) | `{{first_name}}` |
| `email` | To address |
| `tier` | `{{tier}}` |

---

## Playbook 5: Lifetime Member Onboarding

**Purpose:** When a 001 Genesis or 004 Chrome member joins, trigger a multi-step onboarding sequence: permanent Discord role confirmation, welcome packet PDF delivery, and a personal intro message from the founder.

**Platform:** Make.com (better for multi-step sequences)

### Trigger
- **Module:** Airtable → Watch Records
- **Table:** Members
- **Filter:** `tier` is `001_genesis` OR `004_chrome`
- **Filter:** `active = true` (first activation only)

### Sequence

**Step 1 (Immediate) — Discord Role Permanent Flag**
- HTTP POST to Discord API: add special "Lifetime" role in addition to tier role
- Endpoint: `PATCH https://discord.com/api/v10/guilds/{{GUILD_ID}}/members/{{discord_id}}/roles`

**Step 2 (Immediate) — Send Welcome Packet Email**
- HTTP POST to Resend API
- Attach or link to Welcome Packet PDF (hosted on Vercel or Dropbox)
- Email includes:
  - Personal intro from founder
  - How to access the private investment deal flow channel
  - Direct calendar link for 1:1 onboarding call
  - "Your Aurevon Legacy" — what their NFT represents on-chain

**Step 3 (After 1 day) — Personal Founder DM on Discord**
- HTTP POST to Discord API: send DM from bot to member's Discord ID
- Message: personalized welcome referencing their tier and join date

**Step 4 (After 7 days) — Check-in Email**
- Resend API: "How's your first week?" email
- Includes NPS survey link (Typeform or Google Form)

### Field Mappings
| Airtable Field | Used In |
|---|---|
| `discord_id` | Discord role assignment + DM |
| `email` | Resend emails |
| `tier` | Role selection, email copy |
| `joined_at` | Personalization in emails |
| `nft_token_id` | Included in welcome email |

---

## Playbook 6: Pro Retainer Monthly Renewal Check-In

**Purpose:** On the 25th of every month, email active Pro Retainer and Enterprise clients to confirm satisfaction before their subscription renews on the 1st.

**Platform:** Zapier

### Trigger
- **App:** Schedule by Zapier
- **Event:** Every Month — Day 25, 9:00 AM (owner's timezone)

### Actions

**Action 1 — Query Active Retainer Members**
- **App:** Airtable → Search Records
- **Table:** Members
- **Formula:** `AND({tier}="re_retainer",{active}=TRUE())`

**Action 2 — Loop and Send Emails**
- **App:** Looping by Zapier (or Make.com iterator)
- For each member, send via Resend API:
  ```
  Subject: Your Aurevon Pro Retainer renews in 7 days

  Hi {{first_name}},

  Your Aurevon Pro Retainer ($2,500/month) renews on {{renewal_date}}.

  How has this month been? Any deals we should revisit or new priorities?

  Reply to this email or book a quick 15-minute check-in: {{calendar_link}}

  If you need to adjust your retainer scope, let us know before the 1st.

  — The AUREVON CAPITAL Team
  ```

**Action 3 — (Enterprise tier) — Same flow, $5,000 price**
- Repeat for Enterprise members with adjusted copy

### Configuration
- `calendar_link` — set once in Zapier as a static value (your Calendly URL)
- `renewal_date` — calculate as the 1st of next month from the schedule trigger date

---

## Playbook 7: Weekly Digest — Monday 8am

**Purpose:** Every Monday at 8am, receive a summary of the previous week's KPIs so you can review business health in one email.

**Platform:** Zapier

### Trigger
- **App:** Schedule by Zapier
- **Event:** Every Week — Monday, 8:00 AM UTC

### Actions

**Action 1 — Query Revenue (Last 7 Days)**
- Airtable → Search Records → Payments table
- Formula: `AND({status}="completed", IS_AFTER({created_at}, DATEADD(TODAY(),-7,"days")))`
- Sum the `amount` field using a Formatter step

**Action 2 — Query New Members**
- Airtable → Search Records → Members table
- Formula: `IS_AFTER({joined_at}, DATEADD(TODAY(),-7,"days"))`
- Count the records

**Action 3 — Query New Leads**
- Airtable → Search Records → Leads table
- Formula: `IS_AFTER({created_at}, DATEADD(TODAY(),-7,"days"))`
- Count the records

**Action 4 — Query Failed Mints**
- Airtable → Search Records → NFT_Mints table
- Formula: `AND({status}="failed", IS_AFTER({mint_at}, DATEADD(TODAY(),-7,"days")))`
- Count the records

**Action 5 — Send Weekly Digest Email**
- Resend API → to owner email
  ```
  Subject: Aurevon Weekly Digest — Week of {{week_start}}

  Good morning.

  Here's your Aurevon summary for the week of {{week_start}}:

  REVENUE
  ━━━━━━━━━━━━━━━━━━━━━━
  Total this week:     ${{weekly_revenue}}
  New members:         {{new_members}}
  New RE leads:        {{new_leads}}

  OPERATIONS
  ━━━━━━━━━━━━━━━━━━━━━━
  NFTs minted:         {{mints_succeeded}}
  Failed mints:        {{mints_failed}}
  Avg. mint time:      {{avg_mint_seconds}}s

  ACTION NEEDED
  ━━━━━━━━━━━━━━━━━━━━━━
  {{#if mints_failed}}⚠️ {{mints_failed}} mint(s) failed — retry from Operator Hub{{/if}}
  {{#if stale_leads}}⚠️ {{stale_leads}} leads pending > 48h{{/if}}

  View full dashboard: https://aurevonvc.com/operator.html
  ```

---

## Playbook 8: Abandoned Checkout → Recovery Email After 24 Hours

**Purpose:** If a customer starts a Stripe checkout but doesn't complete payment, send a recovery email after 24 hours.

**Note:** Stripe provides abandoned checkout data in the Dashboard → Payments → Incomplete payments.

**Platform:** Zapier (requires Stripe + Resend)

### Trigger
- **App:** Stripe
- **Event:** New Payment Link — abandoned (or use Zapier's Stripe "Checkout Session Expired" trigger)

### Filter
- Only continue if `payment_status` is not `paid`
- Only continue if `customer_email` is not empty
- Only continue if `expires_at` is more than 1 hour ago (prevents triggering on very recent abandonments)

### Actions

**Action 1 — Wait 24 Hours**
- **App:** Delay by Zapier
- **Duration:** 24 hours
- (Note: Zapier's free plan has a 15-minute delay limit; upgrade to Zapier Starter for 24h delays)

**Action 2 — Check if Payment Since Completed**
- **App:** Stripe → Find Checkout Sessions
- **Customer email:** `{{customer_email}}`
- **Filter:** Last 24 hours, status = complete
- Only continue if NO completed sessions found

**Action 3 — Send Recovery Email**
- **App:** Webhooks by Zapier → Resend API
  ```
  Subject: You left something behind...

  Hi {{first_name}},

  It looks like you started joining Aurevon as a {{tier}} member but didn't complete checkout.

  Your spot is still available — but {{tier}} is limited and we can't hold it indefinitely.

  [Complete Your Membership → {{payment_link}}]

  If you had any questions or ran into an issue, reply to this email and we'll sort it out personally.

  — Aurevon
  ```

**Action 4 — Log in Airtable**
- Airtable → Create Record in Leads table
- Status: `abandoned_recovery_sent`
- Note: `Stripe session ${session_id}`

### Field Mappings
| Stripe Field | Email Template |
|---|---|
| `customer_email` | To address, `{{first_name}}` (parse from email) |
| `metadata.tier` | `{{tier}}`, `{{payment_link}}` |
| `id` | `{{session_id}}` for logging |

### Configuration Notes
- `{{payment_link}}` — set as the Payment Link URL for the correct tier (stored as a Zapier lookup table)
- First name from email: use Zapier Formatter → Text → Split → `@` delimiter → take index 0 → capitalize

---

## Setting Up These Playbooks

### Zapier
1. Go to https://zapier.com/app/zaps/new
2. Click "Try it" on any of the template links above (or search manually)
3. Connect your Airtable account (authenticate with your PAT)
4. Connect your other accounts (Stripe, Slack, Resend via webhook)
5. Turn on the Zap → it runs automatically

### Make.com (formerly Integromat)
1. Go to https://www.make.com/en/register
2. Create a new Scenario
3. Add modules matching the steps above
4. Set the schedule and enable the scenario

### Environment Variables Needed
Add these as Zapier Storage or Make.com variables:
- `AIRTABLE_PAT` — your Airtable Personal Access Token
- `AIRTABLE_BASE_ID` — your base ID
- `RESEND_API_KEY` — your Resend API key
- `RESEND_FROM_EMAIL` — verified sender email
- `DISCORD_BOT_TOKEN` — for Discord automation
- `DISCORD_GUILD_ID` — your server ID
- `INTERNAL_API_SECRET` — a secret you define for internal API calls (add to Vercel env vars)
- `OWNER_EMAIL` — where to send digest/alert emails
- `CALENDLY_URL` — your booking link (optional)

### Testing Each Playbook
Before enabling, use the "Test" mode in Zapier or Make.com to run through the steps with sample data. Check that:
1. The trigger fires correctly
2. Airtable queries return expected data
3. Emails send and land in inbox
4. Airtable records are updated correctly
5. No data is duplicated or overwritten incorrectly
