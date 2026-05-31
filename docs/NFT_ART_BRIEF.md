# Aurevon Labs — NFT Membership Pass Art Brief

**Owner:** Aurevon Ventures LLC · **Sub-brand:** Aurevon Labs (Web3/NFT)
**Purpose:** Replace/enhance the 5 membership-pass NFT artworks to a premium, production-grade standard while keeping the existing Crossmint templates and on-chain structure.
**Contact:** mike@aurevonvc.com · (856) 693-8249

> Status: the current templates are LIVE on Crossmint (production, Base mainnet). This brief is for *enhancing the artwork in place* — same 5 templates, better art. Nothing here changes pricing, tiers, or contract logic.

---

## 1. Brand foundation (must follow)

| Element | Spec |
|---|---|
| Primary emblem | The **Aurevon "A" mark** (angular chevron-A, the one in the chrome wordmark / shield). **Do NOT use the old "L+" / BLOCKT emblem** — it is retired. |
| Wordmark | "AUREVON" (Archivo Black / heavy geometric sans). Tier passes may add "AUREVON LABS". |
| Primary blue | `#1E3A8A` → `#3B82F6` gradient |
| Neutrals | Near-black `#0A0A0A` / `#050510`; silver/chrome `#C8C8D0`–`#F0F0F4`; brown accent `#5b4636` (from the Labs banner) used sparingly |
| Tone | Institutional, premium, collectible — "fintech meets luxury collectible." Not cartoonish, not meme-y. |
| Logo files in repo | `assets/Aurevon LOGO1.jpg` (chrome wordmark — current), `assets/MAIN AUREVON HEADER.png` (banner — current), `assets/aurevon_shield_logo_1k.png` (1k shield — favicon/OG) |

---

## 2. Deliverables per tier (5 passes)

Each pass needs **two assets**: a still **image** (card front) and an optional **animation** (looping MP4/GIF) — both already exist as fields on the Crossmint templates (`image` + `animation_url`).

**Technical spec for each:**
- **Image:** 1080×1350 px (4:5 portrait card) OR 1024×1024 (square) — match current aspect; PNG or high-quality JPG, sRGB, < 5 MB.
- **Animation (optional but present today):** 1080×1350, MP4 (H.264) or GIF, 3–6 s seamless loop, < 15 MB.
- Safe margin: keep emblem + tier label ≥ 8% from edges.
- Each must read clearly as a **thumbnail** (Discord/wallet preview) and at full size.

### Tier-by-tier

| # | Tier (NFT name) | Unlocked by | Finish / concept | Accent |
|---|---|---|---|---|
| 1 | **Aurevon Insider** | Full Package ($250) | Brushed **silver** plaque, the Aurevon **A** emblem embossed, clean and foundational | Silver + brand blue |
| 2 | **Aurevon Ember** | Pro Retainer ($1,499/mo) | Hammered **copper** relief, glowing **ember-orange** A emblem, heat/forge texture | Copper + ember glow |
| 3 | **Aurevon Obsidian Executive** | Enterprise ($2,499/mo) | Polished **obsidian** plaque with **24K gold** inlay + engraved executive lettering; apex/1-of-1 feel | Black + gold |
| 001 | **001 Genesis** | Community Monthly ($29.99/mo) | The original Aurevon shield in **brand blue**; "Genesis" energy, particle field | Blue |
| 004 | **004 Chrome** | Community Lifetime ($349.99 one-time) | Polished **chrome** finish, mirror/liquid-metal; "lifetime / best value" prestige | Chrome/silver |

> Naming note: tiers 1–3 are the **underwriting service** passes; 001/004 are the **community** passes. Keep them visually a family (same emblem, frame system) but distinct by material/finish per the table.

---

## 3. Current (placeholder) art — what's being replaced

These are the live IPFS CIDs the site + mint flow currently point at (in `api/_lib/crossmint.js`):

| Tier | Current image CID | Current animation CID |
|---|---|---|
| INSIDER | `bafkreidla5efyue3p23ta6djte7kps4e4aohaxuij7yc2eiundhv3pasty` | `bafybeih4nvmx4pqjvhkbaicb6ngl3jl7mr2ypghwnf26vg4mghzqjpd42m` |
| EMBER | `bafkreifon655t7ru5vrcpnnhsodjal3jb323cjubfx7na4fnp22n6tdb54` | `bafybeidcxh52iyvoymwzpm4z575rtgvlqqnznzzjpt3fqkgyc34tom2ao4` |
| OBSIDIAN | `bafkreie7rhy5sibiocfu5cq7hhwf52tdzgesk3brmj753v2xgulannwsy4` | `bafybeiguz4kqtq3uywhvnhbvlkazaacq3cdnqna6ly2yvyfhwnefhspusq` |
| GENESIS (001) | `bafkreihwovvborajwrljjuiaxhk2lev2l2nxlf5fy27yfh3p74cugt5tfi` | `bafybeictzl6vb5pyqe2vplydessfl3nod2rflzajxhqjlrvxly457bcljy` |
| CHROME (004) | `bafkreic3bi6gpnbhgsncizriwbpcniceipxlzn254zdgvzzilfojajlin4` | `bafybeiecvoqsrxp27pq43ogp3brqzus53caz3zfbtihibs3w4jfzyqboz4` |

---

## 4. Production workflow (after art is approved)

1. **Pin** each new image + animation to IPFS (Pinata — same gateway already in use: `gateway.pinata.cloud/ipfs/<CID>`).
2. **Update the CIDs** in `api/_lib/crossmint.js` → `NFT_IMAGES` and `NFT_ANIMATIONS` (5 entries each).
3. **Update the on-site previews** that now reference IPFS directly:
   - `aurevon-nft.html` — Insider, Ember, Obsidian card `<img>` (lines ~165/187/209)
   - `aurevon-re.html` — Insider, Ember, Obsidian "Your tier. Your shield." cards (lines ~1037/1056/1075)
   - `001_Genesis.html` / `004_Chrome.html` — these render an SVG shield; optionally swap to the new image.
4. **Update the Crossmint template image** for each tier in the Crossmint Console (so already-minted + future mints show the new art) — Console → Collections → [collection] → Templates → edit image.
5. Verify a test mint in staging (`CROSSMINT_ENV=staging`) before pointing production at the new art.

> Because NFTs are immutable per-token *metadata snapshots*, updating the template affects new mints; existing holders' tokens update only if the template's metadata URL is referenced dynamically. Confirm Crossmint's update behavior for your collection type before promising "all holders see the new art."

---

## 5. Acceptance checklist
- [ ] Uses the Aurevon **A** emblem (no "L+"/BLOCKT)
- [ ] Correct material/finish + accent per tier (table §2)
- [ ] Legible as a 256px thumbnail
- [ ] Image ≤ 5 MB, animation ≤ 15 MB, correct dimensions
- [ ] "AUREVON" / "AUREVON LABS" wordmark present and on-brand
- [ ] Family consistency across all 5 passes
- [ ] Delivered as: 5 images + up to 5 loop animations + editable source (AI/PSD/Figma)
