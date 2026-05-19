/**
 * Aurevon Discord Server Setup Bot
 *
 * Builds the complete Aurevon Operators Discord server in ~2 minutes:
 *   • 7 roles with Aurevon brand colors and hierarchy
 *   • 7 categories + 24 channels with full permission overwrites
 *   • 3 embedded messages (rules, verify, welcome)
 *   • Env-var summary printed at end — paste directly into Vercel
 *
 * Usage:
 *   cp .env.example .env   ← fill in BOT_TOKEN and GUILD_ID
 *   npm install
 *   npm run setup
 */

import 'dotenv/config';

// ── Env validation ────────────────────────────────────────────────────────────

const TOKEN    = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const SITE_URL = process.env.SITE_URL ?? 'https://www.aurevonvc.com';

if (!TOKEN)    { console.error('❌  Missing env var: DISCORD_BOT_TOKEN'); process.exit(1); }
if (!GUILD_ID) { console.error('❌  Missing env var: DISCORD_GUILD_ID');  process.exit(1); }

// ── Discord API helper ────────────────────────────────────────────────────────

const BASE = 'https://discord.com/api/v10';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function api(method, path, body) {
  for (;;) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      const wait = Math.ceil(((j.retry_after ?? 1)) * 1000) + 300;
      console.log(`  ⏳  Rate limited — waiting ${(wait / 1000).toFixed(1)}s...`);
      await sleep(wait);
      continue;
    }
    if (res.status === 204) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Discord ${method} ${path} [${res.status}]: ${text}`);
    }
    return res.json();
  }
}

// ── Permission constants ──────────────────────────────────────────────────────

const NONE    = '0';
const VIEW    = String(1024);        // VIEW_CHANNEL
const SEND    = String(2048);        // SEND_MESSAGES
const CONNECT = String(1048576);     // CONNECT (voice)
const SPEAK   = String(2097152);     // SPEAK (voice)
const READ    = String(65536);       // READ_MESSAGE_HISTORY
const EMBED   = String(16384);       // EMBED_LINKS

// Combined bitmasks for common use
function bits(...ns) { return String(ns.reduce((a, b) => BigInt(a) + BigInt(b), 0n)); }
const VIEW_SEND  = bits(VIEW, SEND, READ, EMBED);
const VIEW_ONLY  = bits(VIEW, READ, EMBED);
const VOICE_FULL = bits(VIEW, CONNECT, SPEAK);

// ── Role definitions (highest → lowest, as they'll appear in role list) ───────

const ROLE_DEFS = [
  {
    key:         'bot',
    name:        'Aurevon Bot',
    color:       0x5865F2,   // Discord blurple
    hoist:       false,
    mentionable: false,
    permissions: '268437508', // Manage Roles + Manage Channels + Read + Send + Manage Server
  },
  {
    key:         'genesis',
    name:        '001 Genesis',
    color:       0xC8A96E,   // Gold
    hoist:       true,
    mentionable: false,
    permissions: NONE,
  },
  {
    key:         'chrome',
    name:        '004 Chrome',
    color:       0x9E9E9E,   // Silver
    hoist:       true,
    mentionable: false,
    permissions: NONE,
  },
  {
    key:         'obsidian',
    name:        'Aurevon Obsidian Executive',
    color:       0x4A4A6A,   // Dark Purple
    hoist:       true,
    mentionable: false,
    permissions: NONE,
  },
  {
    key:         'ember',
    name:        'Aurevon Ember',
    color:       0xC0542C,   // Ember Orange
    hoist:       true,
    mentionable: false,
    permissions: NONE,
  },
  {
    key:         'insider',
    name:        'Aurevon Insider',
    color:       0x2A7A4F,   // Forest Green
    hoist:       true,
    mentionable: false,
    permissions: NONE,
  },
  {
    key:         'verified',
    name:        'Verified Member',
    color:       0x808080,   // Grey
    hoist:       true,
    mentionable: false,
    permissions: NONE,
  },
];

// Ascending tier order (lowest → highest) for "minTier" logic
const TIER_ORDER = ['verified', 'insider', 'ember', 'obsidian', 'chrome', 'genesis'];

// ── Channel / category definitions ───────────────────────────────────────────
//
//  minTier       — minimum role to VIEW (and SEND unless readOnly: true)
//  exclusive     — only this one role can access the channel
//  everyoneView  — @everyone can VIEW but not SEND (used for #verify)
//  readOnly      — tier members can VIEW but not SEND (informational channels)
//  botOnly       — invisible to all members; only bot + admins see it
//  voice         — creates a VOICE channel (type 2) instead of TEXT (type 0)
//  embed         — key of the embed to post after channel is created

const CATEGORY_DEFS = [
  {
    name: '🚪 START HERE',
    channels: [
      { name: 'rules',          minTier: 'verified', readOnly: true, embed: 'rules'  },
      { name: 'verify',         everyoneView: true,  readOnly: true, embed: 'verify' },
      { name: 'faq',            minTier: 'verified', readOnly: true                  },
    ],
  },
  {
    name: '📢 GENERAL',
    channels: [
      { name: 'welcome',        minTier: 'verified', readOnly: true, embed: 'welcome' },
      { name: 'announcements',  minTier: 'verified', readOnly: true                   },
      { name: 'intros',         minTier: 'verified'                                   },
      { name: 'general-chat',   minTier: 'verified'                                   },
    ],
  },
  {
    name: '💼 DEAL FLOW',
    channels: [
      { name: 'multifamily',    minTier: 'ember'    },
      { name: 'mixed-use',      minTier: 'obsidian' },
      { name: 'small-cre',      minTier: 'genesis'  },
      { name: 'self-storage',   minTier: 'obsidian' },
      { name: 'deal-reviews',   minTier: 'ember'    },
      { name: 'market-intel',   minTier: 'insider'  },
    ],
  },
  {
    name: '🏨 TIER LOUNGES',
    channels: [
      { name: 'insider-lounge',  exclusive: 'insider'  },
      { name: 'ember-lounge',    exclusive: 'ember'    },
      { name: 'obsidian-lounge', exclusive: 'obsidian' },
      { name: 'genesis-lounge',  exclusive: 'genesis'  },
      { name: 'chrome-lounge',   exclusive: 'chrome'   },
    ],
  },
  {
    name: '🤝 VENDORS & REFERRALS',
    channels: [
      { name: 'lender-referrals', minTier: 'obsidian' },
      { name: 'broker-referrals', minTier: 'genesis'  },
      { name: 'vendor-referrals', minTier: 'chrome'   },
    ],
  },
  {
    name: '🎙️ VOICE ROOMS',
    channels: [
      { name: 'General Lounge',   voice: true, minTier: 'verified'  },
      { name: 'Deal Room',        voice: true, minTier: 'ember'     },
      { name: 'Operator Suite',   voice: true, minTier: 'obsidian'  },
      { name: 'Genesis War Room', voice: true, minTier: 'genesis'   },
    ],
  },
  {
    name: '🔧 BOT & LOGS',
    botOnly: true,
    channels: [
      { name: 'bot-commands' },
      { name: 'join-logs'    },
      { name: 'role-logs'    },
      { name: 'audit-log'    },
      { name: 'mod-actions'  },
    ],
  },
];

// ── Embed definitions ─────────────────────────────────────────────────────────

function buildRulesEmbed() {
  return {
    embeds: [{
      title: '⬛  Aurevon Community Standards',
      color: 0xC8A96E,
      description:
        'These standards exist to protect the quality and integrity of this network. ' +
        'By participating, you agree to uphold them.',
      fields: [
        {
          name:  '1. Respect & Professionalism',
          value: 'Treat every member with respect. No personal attacks, harassment, or inflammatory language.',
          inline: false,
        },
        {
          name:  '2. No Spam or Unsolicited Promotion',
          value: 'No spamming, unsolicited DMs, or self-promotion outside designated channels.',
          inline: false,
        },
        {
          name:  '3. Deal Sourcing Etiquette',
          value: 'Share deals in the correct channel. Misrepresenting deals, terms, or your role in a transaction is grounds for removal.',
          inline: false,
        },
        {
          name:  '4. Confidentiality',
          value: 'What is shared in tier lounges stays there. Do not screenshot or redistribute private discussions.',
          inline: false,
        },
        {
          name:  '5. Verified Information Only',
          value: 'Label unverified leads clearly. Do not present speculation as fact when it comes to deals or market data.',
          inline: false,
        },
        {
          name:  '6. No Illegal or Harmful Content',
          value: 'No content that violates Discord ToS, federal law, or that constitutes unlicensed financial or legal advice.',
          inline: false,
        },
        {
          name:  '7. Stay On Topic',
          value: 'Keep discussions relevant to real estate, deal flow, and operator topics. Political and off-topic debates belong elsewhere.',
          inline: false,
        },
      ],
      footer: { text: 'Violations may result in role revocation and removal from the server. · Aurevon Ventures LLC' },
      timestamp: new Date().toISOString(),
    }],
  };
}

function buildVerifyEmbed() {
  return {
    embeds: [{
      title: '🔐  Verify Your Aurevon Membership',
      color: 0x5865F2,
      description:
        'To unlock tier channels you must verify your Aurevon NFT membership.\n\n' +
        '**How it works:**\n' +
        '1. Visit the Aurevon member portal (button below)\n' +
        '2. Sign in with the email you used at purchase\n' +
        '3. Click **Connect Discord** and authorize\n' +
        '4. Your tier role is assigned automatically — no waiting\n\n' +
        '_Already verified? Your role should appear in the member list on the right._',
      fields: [
        {
          name:  '🟡 001 Genesis',
          value: 'Monthly membership — full server access + Genesis War Room',
          inline: true,
        },
        {
          name:  '⬜ 004 Chrome',
          value: 'Lifetime membership — permanent full server access',
          inline: true,
        },
        {
          name:  '​',
          value: '​',
          inline: false,
        },
        {
          name:  '🟣 Aurevon Obsidian Executive',
          value: 'Advanced deal flow + Obsidian Lounge + vendor channels',
          inline: true,
        },
        {
          name:  '🟠 Aurevon Ember',
          value: 'Core deal flow + Ember Lounge + Deal Room voice',
          inline: true,
        },
        {
          name:  '🟢 Aurevon Insider',
          value: 'Market intel + Insider Lounge + General access',
          inline: true,
        },
      ],
      footer: { text: 'Questions? Email support@aurevonvc.com' },
    }],
    components: [{
      type: 1,
      components: [
        {
          type:  2,
          style: 5,   // LINK
          label: 'Member Portal',
          url:   `${SITE_URL}/member-claim.html`,
          emoji: { name: '🔑' },
        },
        {
          type:  2,
          style: 5,
          label: 'Visit Aurevon',
          url:   SITE_URL,
          emoji: { name: '🌐' },
        },
      ],
    }],
  };
}

function buildWelcomeEmbed() {
  return {
    embeds: [{
      title: 'Welcome to Aurevon Operators ⬛',
      color: 0xC8A96E,
      description:
        'You have joined an exclusive network of real estate operators, deal makers, and institutional-minded investors. ' +
        'Your tier unlocks specific channels — the higher your pass, the deeper you go.\n\n' +
        '**Start here:**',
      fields: [
        {
          name:  '📋  #verify',
          value: 'Link your NFT membership to unlock your tier role.',
          inline: false,
        },
        {
          name:  '📢  #announcements',
          value: 'Aurevon deal flow alerts, platform updates, and network news.',
          inline: false,
        },
        {
          name:  '👋  #intros',
          value: 'Drop a one-liner on who you are and what markets you operate in.',
          inline: false,
        },
        {
          name:  '💼  Deal Flow Channels',
          value:
            '`#market-intel` → Insider+\n' +
            '`#multifamily` / `#deal-reviews` → Ember+\n' +
            '`#mixed-use` / `#self-storage` → Obsidian+\n' +
            '`#small-cre` → Genesis only',
          inline: false,
        },
        {
          name:  '🏨  Tier Lounges',
          value: 'Each tier has a private lounge visible only to that tier. Find yours in the channel list.',
          inline: false,
        },
        {
          name:  '🤝  Vendors & Referrals',
          value: 'Vetted lenders, brokers, and vendor referrals. Access gated at Obsidian / Chrome / Genesis.',
          inline: false,
        },
        {
          name:  '🎙️  Voice Rooms',
          value:
            '`General Lounge` → all verified\n' +
            '`Deal Room` → Ember+\n' +
            '`Operator Suite` → Obsidian+\n' +
            '`Genesis War Room` → Genesis only',
          inline: false,
        },
      ],
      footer: { text: 'Aurevon Ventures LLC · Built for Operators.' },
      timestamp: new Date().toISOString(),
    }],
  };
}

const EMBEDS = {
  rules:   buildRulesEmbed,
  verify:  buildVerifyEmbed,
  welcome: buildWelcomeEmbed,
};

// ── Step 1: Create roles ──────────────────────────────────────────────────────

async function createRoles() {
  console.log('\n── Creating roles ──────────────────────────────────────────');
  const map = {};  // key → { id, name }

  // Fetch existing roles to avoid duplicates
  const existing = await api('GET', `/guilds/${GUILD_ID}/roles`);
  const existingByName = new Map(existing.map(r => [r.name, r]));

  for (const def of ROLE_DEFS) {
    if (existingByName.has(def.name)) {
      const r = existingByName.get(def.name);
      console.log(`  ✓  ${def.name} (already exists — ${r.id})`);
      map[def.key] = { id: r.id, name: r.name };
      continue;
    }
    const created = await api('POST', `/guilds/${GUILD_ID}/roles`, {
      name:        def.name,
      color:       def.color,
      hoist:       def.hoist,
      mentionable: def.mentionable,
      permissions: def.permissions ?? NONE,
    });
    console.log(`  ✅  ${def.name} (${created.id})`);
    map[def.key] = { id: created.id, name: created.name };
    await sleep(300);
  }

  return map;
}

// ── Step 2: Set role positions ────────────────────────────────────────────────
//
//  Position 1 = bottom (just above @everyone)
//  Higher number = higher in list
//  Aurevon Bot must be at the top so it can manage all tier roles.

async function setRolePositions(roleMap) {
  console.log('\n── Setting role positions ──────────────────────────────────');

  // Desired order (ascending position — index 0 = lowest, last = highest)
  const desired = [
    'verified',  // position 1 — lowest member role
    'insider',   // position 2
    'ember',     // position 3
    'obsidian',  // position 4
    'chrome',    // position 5
    'genesis',   // position 6
    'bot',       // position 7 — must stay above all tier roles
  ];

  const positions = desired.map((key, i) => ({
    id:       roleMap[key].id,
    position: i + 1,
  }));

  await api('PATCH', `/guilds/${GUILD_ID}/roles`, positions);
  console.log('  ✅  Role hierarchy set (Aurevon Bot at top)');
}

// ── Step 3: Build permission overwrite arrays ─────────────────────────────────

function buildOverwrites(guildId, roleMap, channelDef, categoryBotOnly) {
  const everyone = guildId; // @everyone role ID equals the guild ID
  const overwrites = [];

  if (categoryBotOnly || channelDef.botOnly) {
    // Invisible to all members; bot can see
    overwrites.push({ id: everyone,           type: 0, allow: NONE, deny: VIEW });
    overwrites.push({ id: roleMap.bot.id,     type: 0, allow: bits(VIEW, SEND, READ, EMBED), deny: NONE });
    return overwrites;
  }

  if (channelDef.everyoneView) {
    // #verify — @everyone can see but not send; verified+ can also send
    overwrites.push({ id: everyone, type: 0, allow: VIEW_ONLY, deny: SEND });
    for (const tier of TIER_ORDER) {
      overwrites.push({ id: roleMap[tier].id, type: 0, allow: VIEW_SEND, deny: NONE });
    }
    overwrites.push({ id: roleMap.bot.id, type: 0, allow: VIEW_SEND, deny: NONE });
    return overwrites;
  }

  if (channelDef.exclusive) {
    // Tier lounge — only that specific role
    overwrites.push({ id: everyone,                           type: 0, allow: NONE, deny: VIEW });
    overwrites.push({ id: roleMap[channelDef.exclusive].id,   type: 0, allow: VIEW_SEND, deny: NONE });
    overwrites.push({ id: roleMap.bot.id,                     type: 0, allow: VIEW_SEND, deny: NONE });
    return overwrites;
  }

  if (channelDef.minTier) {
    const minIdx = TIER_ORDER.indexOf(channelDef.minTier);
    const allow = channelDef.readOnly
      ? VIEW_ONLY
      : (channelDef.voice ? VOICE_FULL : VIEW_SEND);

    overwrites.push({ id: everyone, type: 0, allow: NONE, deny: VIEW });

    for (let i = minIdx; i < TIER_ORDER.length; i++) {
      overwrites.push({ id: roleMap[TIER_ORDER[i]].id, type: 0, allow: allow, deny: NONE });
    }
    overwrites.push({ id: roleMap.bot.id, type: 0, allow: VIEW_SEND, deny: NONE });
    return overwrites;
  }

  return overwrites;
}

// ── Step 4: Create categories and channels ────────────────────────────────────

async function createChannels(roleMap) {
  console.log('\n── Creating categories and channels ────────────────────────');
  const channelMap = {};  // channelName → channelId

  for (const catDef of CATEGORY_DEFS) {
    // Create category
    const cat = await api('POST', `/guilds/${GUILD_ID}/channels`, {
      name:                 catDef.name,
      type:                 4,   // GUILD_CATEGORY
      permission_overwrites: catDef.botOnly
        ? [
            { id: GUILD_ID,          type: 0, allow: NONE,     deny: VIEW },
            { id: roleMap.bot.id,    type: 0, allow: VIEW_SEND, deny: NONE },
          ]
        : [],
    });
    console.log(`\n  📁  ${catDef.name} (${cat.id})`);
    await sleep(400);

    for (const chDef of catDef.channels) {
      const overwrites = buildOverwrites(GUILD_ID, roleMap, chDef, catDef.botOnly);

      const channel = await api('POST', `/guilds/${GUILD_ID}/channels`, {
        name:                  chDef.name,
        type:                  chDef.voice ? 2 : 0,
        parent_id:             cat.id,
        permission_overwrites: overwrites,
      });

      console.log(`     ✅  #${chDef.name} (${channel.id})`);
      channelMap[chDef.name] = channel.id;

      if (chDef.embed) {
        channelMap[`__embed_${chDef.embed}`] = channel.id;
      }

      await sleep(350);
    }
  }

  return channelMap;
}

// ── Step 5: Post embeds ───────────────────────────────────────────────────────

async function postEmbeds(channelMap) {
  console.log('\n── Posting embeds ──────────────────────────────────────────');

  for (const [key, buildFn] of Object.entries(EMBEDS)) {
    const channelId = channelMap[`__embed_${key}`];
    if (!channelId) {
      console.warn(`  ⚠️   No channel found for embed "${key}" — skipped`);
      continue;
    }
    const payload = buildFn();
    await api('POST', `/channels/${channelId}/messages`, payload);
    console.log(`  ✅  Posted "${key}" embed → ${channelId}`);
    await sleep(500);
  }
}

// ── Step 6: Print env var summary ────────────────────────────────────────────

function printEnvSummary(roleMap) {
  const line = '═'.repeat(60);

  // Map role keys to Vercel env var names (matching .env.example)
  const roleEnvMap = {
    bot:      'DISCORD_ROLE_BOT',
    genesis:  'DISCORD_ROLE_MONTHLY',    // monthly_membership → 001 Genesis
    chrome:   'DISCORD_ROLE_LIFETIME',   // lifetime_membership → 004 Chrome
    obsidian: 'DISCORD_ROLE_PRODUCT_C',  // product_c_reward → Obsidian
    ember:    'DISCORD_ROLE_PRODUCT_B',  // product_b_reward → Ember
    insider:  'DISCORD_ROLE_PRODUCT_A',  // product_a_reward → Insider
    verified: 'DISCORD_ROLE_VERIFIED',
  };

  console.log(`\n${line}`);
  console.log('  PASTE THESE INTO VERCEL → Settings → Environment Variables');
  console.log(line);
  console.log('');
  console.log(`DISCORD_GUILD_ID=${GUILD_ID}`);
  for (const [key, envKey] of Object.entries(roleEnvMap)) {
    if (roleMap[key]) {
      console.log(`${envKey}=${roleMap[key].id}`);
    }
  }
  console.log('');
  console.log(line);
  console.log('  ENTITLEMENT → ROLE MAPPING (for reference)');
  console.log(line);
  console.log('  monthly_membership   → 001 Genesis          → DISCORD_ROLE_MONTHLY');
  console.log('  lifetime_membership  → 004 Chrome           → DISCORD_ROLE_LIFETIME');
  console.log('  product_c_reward     → Obsidian Executive   → DISCORD_ROLE_PRODUCT_C');
  console.log('  product_b_reward     → Aurevon Ember        → DISCORD_ROLE_PRODUCT_B');
  console.log('  product_a_reward     → Aurevon Insider      → DISCORD_ROLE_PRODUCT_A');
  console.log(line);
  console.log('');
  console.log('  MANUAL STEPS (cannot be automated via API):');
  console.log('    1. Server Settings → Safety Setup');
  console.log('       • Enable Community Mode');
  console.log('       • Rules Channel → #rules');
  console.log('       • Updates Channel → #announcements');
  console.log('    2. Server Settings → Onboarding');
  console.log('       • Add #verify as first step');
  console.log('       • Add #rules as required read');
  console.log('    3. Server Settings → Moderation');
  console.log('       • Verification Level: Medium (email required)');
  console.log('       • Explicit Media Content Filter: All members');
  console.log('    4. Drag "Aurevon Bot" role to VERY TOP of role list.');
  console.log(line);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n⬛  AUREVON DISCORD SERVER SETUP');
  console.log(`    Guild: ${GUILD_ID}`);
  console.log(`    Site:  ${SITE_URL}`);

  const roleMap    = await createRoles();
  await setRolePositions(roleMap);
  const channelMap = await createChannels(roleMap);
  await postEmbeds(channelMap);
  printEnvSummary(roleMap);

  console.log('\n✅  Setup complete — ~2 minutes of Discord rate limits finished.\n');
}

main().catch(err => {
  console.error(`\n❌  Setup failed: ${err.message}`);
  if (err.message.includes('Missing Permissions')) {
    console.error('    → Bot role needs Manage Roles + Manage Channels + Manage Server.');
    console.error('    → Re-invite bot using the URL in discord/README.md.');
  }
  if (err.message.includes('Unknown Guild')) {
    console.error('    → Bot is not in the server. Complete the OAuth invite step first.');
  }
  process.exit(1);
});
