#!/usr/bin/env node
/**
 * setup-discord-roles.js
 *
 * Creates the 5 Aurevon entitlement Discord roles if they don't already exist,
 * then prints the role IDs to paste into Vercel Environment Variables.
 *
 * Usage:
 *   DISCORD_BOT_TOKEN=<your-bot-token> DISCORD_GUILD_ID=<your-guild-id> node scripts/setup-discord-roles.js
 *
 * Required:
 *   DISCORD_BOT_TOKEN  — Bot token from Discord Developer Portal (Bot tab)
 *   DISCORD_GUILD_ID   — Your Discord server ID (Server Settings → Widget → Server ID)
 *
 * The bot must have the "Manage Roles" permission and be positioned ABOVE these
 * roles in the role hierarchy (Settings → Roles → drag bot role higher).
 *
 * After running, copy the output values to Vercel:
 *   Dashboard → Project → Settings → Environment Variables
 */

const DISCORD_API = 'https://discord.com/api/v10';

const ROLES_TO_CREATE = [
  {
    envVar: 'DISCORD_ROLE_MONTHLY',
    name: 'Aurevon Monthly Member',
    color: 0x1E3A8A,   // dark blue
    hoist: false,
    mentionable: false,
    permissions: '0',
  },
  {
    envVar: 'DISCORD_ROLE_LIFETIME',
    name: 'Aurevon Lifetime Member',
    color: 0xC8C8D0,   // chrome silver
    hoist: false,
    mentionable: false,
    permissions: '0',
  },
  {
    envVar: 'DISCORD_ROLE_PRODUCT_A',
    name: 'Aurevon Insider',
    color: 0xC0C0DC,   // soft silver-blue
    hoist: true,
    mentionable: false,
    permissions: '0',
  },
  {
    envVar: 'DISCORD_ROLE_PRODUCT_B',
    name: 'Aurevon Ember',
    color: 0xD4622A,   // ember orange
    hoist: true,
    mentionable: false,
    permissions: '0',
  },
  {
    envVar: 'DISCORD_ROLE_PRODUCT_C',
    name: 'Aurevon Obsidian Executive',
    color: 0xB44F1E,   // deep amber
    hoist: true,
    mentionable: false,
    permissions: '0',
  },
];

async function main() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token || !guildId) {
    console.error('ERROR: Set DISCORD_BOT_TOKEN and DISCORD_GUILD_ID environment variables.');
    console.error('Usage: DISCORD_BOT_TOKEN=xxx DISCORD_GUILD_ID=yyy node scripts/setup-discord-roles.js');
    process.exit(1);
  }

  const headers = {
    Authorization: `Bot ${token}`,
    'Content-Type': 'application/json',
  };

  // Fetch existing roles
  console.log(`Fetching existing roles for guild ${guildId}...`);
  const existingRes = await fetch(`${DISCORD_API}/guilds/${guildId}/roles`, { headers });
  if (!existingRes.ok) {
    const body = await existingRes.text();
    console.error(`Failed to fetch roles (${existingRes.status}): ${body}`);
    process.exit(1);
  }
  const existingRoles = await existingRes.json();
  const existingByName = new Map(existingRoles.map(r => [r.name, r]));

  console.log(`Found ${existingRoles.length} existing roles.\n`);

  const results = [];

  for (const roleSpec of ROLES_TO_CREATE) {
    const existing = existingByName.get(roleSpec.name);
    if (existing) {
      console.log(`  [SKIP]   "${roleSpec.name}" already exists — id=${existing.id}`);
      results.push({ envVar: roleSpec.envVar, id: existing.id, name: roleSpec.name, created: false });
      continue;
    }

    const createRes = await fetch(`${DISCORD_API}/guilds/${guildId}/roles`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: roleSpec.name,
        color: roleSpec.color,
        hoist: roleSpec.hoist,
        mentionable: roleSpec.mentionable,
        permissions: roleSpec.permissions,
      }),
    });

    if (!createRes.ok) {
      const body = await createRes.text();
      console.error(`  [ERROR]  Failed to create "${roleSpec.name}" (${createRes.status}): ${body}`);
      results.push({ envVar: roleSpec.envVar, id: null, name: roleSpec.name, created: false, error: true });
      continue;
    }

    const role = await createRes.json();
    console.log(`  [CREATE] "${role.name}" created — id=${role.id}`);
    results.push({ envVar: roleSpec.envVar, id: role.id, name: role.name, created: true });

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n=== VERCEL ENVIRONMENT VARIABLES ===');
  console.log('Paste these into: Vercel → Project → Settings → Environment Variables\n');

  for (const r of results) {
    if (r.id) {
      console.log(`${r.envVar}=${r.id}`);
    } else {
      console.log(`${r.envVar}=<FAILED — check error above>`);
    }
  }

  console.log('\n=== ALSO REQUIRED (if not set) ===');
  console.log('DISCORD_BOT_TOKEN=<your-bot-token>');
  console.log('DISCORD_GUILD_ID=<your-guild-id>');
  console.log('DISCORD_INVITE_URL=https://discord.gg/<your-invite-code>');

  const failures = results.filter(r => r.error);
  if (failures.length > 0) {
    console.error(`\n${failures.length} role(s) failed to create. Check the errors above.`);
    process.exit(1);
  }

  console.log('\nDone. Copy the values above to Vercel and redeploy.');
}

main().catch(err => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
