/**
 * ============================================================
 *  AUREVON VENTURES — COMPLETE DISCORD BOT
 *  discord.js v14 | Node 18+
 * ============================================================
 *
 *  FEATURES:
 *  ─────────────────────────────────────────────────────────
 *  MODERATION
 *    /warn /warnings /clearwarnings
 *    /timeout /kick /ban /unban
 *    /purge /slowmode /lock /unlock
 *    /modnote
 *    Audit-log events (ban/kick/role changes)
 *
 *  MARKETING
 *    /announce           — branded embed to #announcements
 *    /dm-tier            — DM every member of a specific tier
 *    /promo              — broadcast promo code with embed
 *    /poll               — reaction poll (up to 4 options)
 *
 *  AUTHORIZATION & VERIFICATION
 *    /sync-member        — assign tier role from Airtable by email
 *    /revoke-member      — strip all managed roles
 *    /sync-all           — batch sync all pending Airtable members
 *    /verify-member      — force-link email + Discord ID
 *    Auto welcome DM on join with portal link
 *
 *  ROLE MANAGEMENT
 *    /add-role           — add any role to a member
 *    /remove-role        — remove any role from a member
 *    /role-info          — details about any role
 *    /create-role        — create a new server role
 *
 *  SERVER MANAGEMENT
 *    /setup-server       — full channel/category/role scaffolding
 *    /create-channel     — create a text or voice channel
 *    /server-info        — rich server overview embed
 *    /set-topic          — set a channel's topic
 *    /event create       — schedule a voice event
 *    /event list         — list upcoming events
 *
 *  SUPPORT TICKET SYSTEM
 *    /ticket-setup       — post the "Open a Ticket" button panel
 *    /close-ticket       — close + archive active ticket
 *    Button: "🎫 Open Ticket" → creates private ticket channel
 *
 *  ANALYTICS
 *    /stats              — live tier + member breakdown
 *    /boost-stats        — server boost level & progress
 *    /lookup             — full Airtable profile for a member
 *    /member-report      — complete report (Airtable + Discord)
 *    /welcome-dm         — re-send verification DM
 *    /boost-stats        — boost level / perks overview
 *
 *  AUTOMOD (auto-created on startup)
 *    Mention spam limit (5 mentions max)
 *    Spam filter
 *    Keyword filter (scam / pump-and-dump language)
 *
 *  REAL-TIME EVENTS
 *    Member join  → welcome DM + #join-logs embed
 *    Member leave → #join-logs embed
 *    Role change  → #role-logs embed (tier roles only)
 *    Boost added  → #announcements celebration + #role-logs
 *    Event start  → live announcement in #announcements
 *    Entitlement  → Discord premium subscription handler
 *
 * ============================================================
 *  SETUP
 * ============================================================
 *
 *  1. npm install discord.js dotenv
 *
 *  2. Create .env (see REQUIRED ENV VARS below)
 *
 *  3. Discord Developer Portal → Bot:
 *       ✅ SERVER MEMBERS INTENT (privileged)
 *       ✅ MESSAGE CONTENT INTENT (privileged)
 *       ✅ PRESENCE INTENT (privileged)
 *     Permissions integer: 8 (Administrator) or granular below
 *     Granular: Manage Roles, Manage Channels, Kick Members,
 *               Ban Members, Moderate Members, Manage Messages,
 *               Send Messages, Use Slash Commands, View Audit Log
 *
 *  4. Invite URL (OAuth2 → URL Generator):
 *       Scopes: bot, applications.commands
 *       Bot Permissions: Administrator (simplest) or granular above
 *
 *  5. Move "Aurevon Bot" role ABOVE all tier roles in
 *     Server Settings → Roles (drag to top)
 *
 *  6. node bot.js
 *
 * ============================================================
 *  REQUIRED ENV VARS
 * ============================================================
 *
 *  DISCORD_BOT_TOKEN=               ← Bot → Reset Token
 *  DISCORD_GUILD_ID=1499526813490221207
 *  DISCORD_CLIENT_ID=1505819653602148372
 *  SITE_URL=https://www.aurevonvc.com
 *
 *  # Role IDs (right-click role in Discord → Copy Role ID)
 *  DISCORD_ROLE_MONTHLY=            ← 001 Genesis
 *  DISCORD_ROLE_LIFETIME=           ← 004 Chrome
 *  DISCORD_ROLE_PRODUCT_A=          ← Aurevon Insider
 *  DISCORD_ROLE_PRODUCT_B=          ← Aurevon Ember
 *  DISCORD_ROLE_PRODUCT_C=          ← Obsidian Executive
 *  DISCORD_ROLE_VERIFIED=           ← Verified Member
 *
 *  # Airtable (optional — bot works without it, sync features disabled)
 *  AIRTABLE_PAT=pat...
 *  AIRTABLE_BASE_ID=appI9X8vcRcK1QZ1l
 *
 * ============================================================
 */

import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
  ActivityType,
  Events,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventEntityType,
  GuildScheduledEventStatus,
  AutoModerationRuleTriggerType,
  AutoModerationRuleEventType,
  AutoModerationActionType,
  AuditLogEvent,
} from 'discord.js';

// ── Env ───────────────────────────────────────────────────────────────────────

const TOKEN     = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID  = process.env.DISCORD_GUILD_ID  ?? '1499526813490221207';
const CLIENT_ID = process.env.DISCORD_CLIENT_ID ?? '1505819653602148372';
const SITE_URL  = process.env.SITE_URL          ?? 'https://www.aurevonvc.com';

const AT_PAT     = process.env.AIRTABLE_PAT;
const AT_BASE    = process.env.AIRTABLE_BASE_ID ?? 'appI9X8vcRcK1QZ1l';
const AT_MEMBERS = process.env.AIRTABLE_TABLE_MEMBERS   ?? 'tblYPn7hxnrgH723B';
const AT_MINTS   = process.env.AIRTABLE_TABLE_NFT_MINTS ?? 'tbliXEGJdoEIAJU06';

if (!TOKEN) {
  console.error('❌  DISCORD_BOT_TOKEN is required — add it to .env');
  process.exit(1);
}

// ── Airtable helpers (inline — no external lib required) ──────────────────────

const AT_HEADERS = AT_PAT
  ? { Authorization: `Bearer ${AT_PAT}`, 'Content-Type': 'application/json' }
  : null;

async function atFetch(tableId, formula) {
  if (!AT_HEADERS) return [];
  const url = `https://api.airtable.com/v0/${AT_BASE}/${tableId}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=50`;
  const r = await fetch(url, { headers: AT_HEADERS });
  if (!r.ok) return [];
  const d = await r.json();
  return d.records ?? [];
}

async function atPatch(tableId, recordId, fields) {
  if (!AT_HEADERS) return;
  await fetch(`https://api.airtable.com/v0/${AT_BASE}/${tableId}/${recordId}`, {
    method: 'PATCH',
    headers: AT_HEADERS,
    body: JSON.stringify({ fields }),
  });
}

async function findMember(email) {
  const rows = await atFetch(AT_MEMBERS, `LOWER({Email})="${email.toLowerCase()}"`);
  return rows[0] ?? null;
}

async function findMint(email) {
  const rows = await atFetch(
    AT_MINTS,
    `AND(LOWER({Email})="${email.toLowerCase()}",OR({Mint Status}="Minted",{Mint Status}="Sent"))`
  );
  return rows[0] ?? null;
}

// ── Role config ───────────────────────────────────────────────────────────────

const TIER_ROLES = {
  monthly:   { env: 'DISCORD_ROLE_MONTHLY',   label: '001 Genesis',           nftType: 'comm_monthly'   },
  lifetime:  { env: 'DISCORD_ROLE_LIFETIME',  label: '004 Chrome',            nftType: 'comm_lifetime'  },
  product_a: { env: 'DISCORD_ROLE_PRODUCT_A', label: 'Aurevon Insider',        nftType: 'Aurevon Insider'        },
  product_b: { env: 'DISCORD_ROLE_PRODUCT_B', label: 'Aurevon Ember',          nftType: 'Aurevon Ember'          },
  product_c: { env: 'DISCORD_ROLE_PRODUCT_C', label: 'Obsidian Executive',     nftType: 'Aurevon Obsidian Executive' },
};

function roleIdFor(key)      { return process.env[TIER_ROLES[key]?.env] ?? null; }
function getTierRoleIds()    { return Object.values(TIER_ROLES).map(t => process.env[t.env]).filter(Boolean); }
function getManagedRoleIds() { return [...getTierRoleIds(), process.env.DISCORD_ROLE_VERIFIED].filter(Boolean); }

function resolveRoleFromNft(nftType) {
  const entry = Object.values(TIER_ROLES).find(t =>
    nftType?.toLowerCase().includes(t.nftType?.toLowerCase())
  );
  if (!entry) return null;
  return process.env[entry.env] ?? null;
}

// ── Warning store (in-memory — persists until restart) ────────────────────────
// Replace with Airtable or Redis for production persistence

const warnStore = new Map(); // userId → [{ reason, mod, ts }]

function addWarn(userId, reason, modTag) {
  const list = warnStore.get(userId) ?? [];
  list.push({ reason, mod: modTag, ts: new Date().toISOString() });
  warnStore.set(userId, list);
  return list.length;
}

function getWarns(userId)   { return warnStore.get(userId) ?? []; }
function clearWarns(userId) { warnStore.delete(userId); }

// ── Ticket store (in-memory) ──────────────────────────────────────────────────

const openTickets = new Map(); // channelId → { userId, createdAt }

// ── Embed helpers ─────────────────────────────────────────────────────────────

const GOLD  = 0xC8A96E;
const RED   = 0xED4245;
const GREEN = 0x57F287;
const BLUE  = 0x5865F2;

function goldEmbed(title) {
  return new EmbedBuilder()
    .setColor(GOLD).setTitle(title)
    .setFooter({ text: 'Aurevon Ventures LLC' }).setTimestamp();
}

function redEmbed(title) {
  return new EmbedBuilder()
    .setColor(RED).setTitle(title).setTimestamp();
}

function buildWelcomeDm() {
  return new EmbedBuilder()
    .setColor(GOLD)
    .setTitle('Welcome to Aurevon Operators ⬛')
    .setDescription(
      'You have joined an exclusive network of real estate operators and investors.\n\n' +
      '**To unlock your tier channels, verify your membership below:**'
    )
    .addFields(
      { name: '1️⃣  Member Portal', value: `[Open here →](${SITE_URL}/member-claim.html) — sign in with your purchase email.`, inline: false },
      { name: '2️⃣  Connect Discord', value: 'Click **Connect Discord** in the portal. Your tier role is assigned automatically.', inline: false },
      { name: '❓  Need help?',       value: 'Email **support@aurevongroup.com** or open a ticket in the server.', inline: false },
    )
    .setFooter({ text: 'Aurevon Ventures LLC' });
}

function buildJoinEmbed(member) {
  const ageDays = Math.floor((Date.now() - member.user.createdTimestamp) / 86_400_000);
  return new EmbedBuilder().setColor(GREEN).setTitle('📥  New Member')
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      { name: 'User',        value: `<@${member.id}> (${member.user.tag})`,     inline: true },
      { name: 'Account Age', value: `${ageDays}d`,                              inline: true },
      { name: 'Member #',    value: String(member.guild.memberCount),           inline: true },
    )
    .setFooter({ text: `ID: ${member.id}` }).setTimestamp();
}

function buildLeaveEmbed(member) {
  const roles = member.roles.cache.filter(r => r.id !== member.guild.id).map(r => r.name).join(', ') || 'None';
  return new EmbedBuilder().setColor(RED).setTitle('📤  Member Left')
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      { name: 'User',  value: `${member.user.tag}`, inline: true },
      { name: 'ID',    value: member.id,            inline: true },
      { name: 'Roles', value: roles,                inline: false },
    ).setTimestamp();
}

function buildModEmbed(action, mod, target, reason, extra = {}) {
  const colors = { warn: 0xFEE75C, timeout: 0xFFA500, kick: RED, ban: RED, unban: GREEN, note: BLUE };
  const icons  = { warn: '⚠️', timeout: '⏱️', kick: '👢', ban: '🔨', unban: '✅', note: '📝' };
  return new EmbedBuilder()
    .setColor(colors[action] ?? GOLD)
    .setTitle(`${icons[action] ?? '🛡️'}  ${action.charAt(0).toUpperCase() + action.slice(1)} — ${target.tag}`)
    .addFields(
      { name: 'User',      value: `<@${target.id}> (${target.tag})`, inline: true  },
      { name: 'Moderator', value: `<@${mod.id}>`,                    inline: true  },
      { name: 'Reason',    value: reason || 'No reason provided',    inline: false },
      ...Object.entries(extra).map(([k, v]) => ({ name: k, value: String(v), inline: true })),
    )
    .setFooter({ text: `Target ID: ${target.id}` }).setTimestamp();
}

// ── Channel helpers ───────────────────────────────────────────────────────────

function ch(guild, name, type = ChannelType.GuildText) {
  return guild.channels.cache.find(c => c.name === name && c.type === type) ?? null;
}

async function log(guild, channelName, payload) {
  const c = ch(guild, channelName);
  if (c) await c.send(payload).catch(() => {});
}

// ── Slash command definitions ─────────────────────────────────────────────────

const ADMIN = PermissionFlagsBits.Administrator;
const MOD   = PermissionFlagsBits.ModerateMembers;

const COMMANDS = [

  // ── MODERATION ────────────────────────────────────────────────────────────

  new SlashCommandBuilder().setName('warn')
    .setDescription('Issue a formal warning to a member')
    .setDefaultMemberPermissions(MOD)
    .addUserOption(o => o.setName('user').setDescription('Member to warn').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Warning reason').setRequired(true)),

  new SlashCommandBuilder().setName('warnings')
    .setDescription('View warning history for a member')
    .setDefaultMemberPermissions(MOD)
    .addUserOption(o => o.setName('user').setDescription('Member to check').setRequired(true)),

  new SlashCommandBuilder().setName('clearwarnings')
    .setDescription('Clear all warnings for a member')
    .setDefaultMemberPermissions(ADMIN)
    .addUserOption(o => o.setName('user').setDescription('Member to clear').setRequired(true)),

  new SlashCommandBuilder().setName('timeout')
    .setDescription('Timeout a member (prevent them from sending messages)')
    .setDefaultMemberPermissions(MOD)
    .addUserOption(o => o.setName('user').setDescription('Member to timeout').setRequired(true))
    .addIntegerOption(o => o.setName('minutes').setDescription('Timeout duration in minutes (max 40320)').setRequired(true)
      .setMinValue(1).setMaxValue(40320))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),

  new SlashCommandBuilder().setName('kick')
    .setDescription('Kick a member from the server')
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption(o => o.setName('user').setDescription('Member to kick').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),

  new SlashCommandBuilder().setName('ban')
    .setDescription('Ban a user from the server')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(o => o.setName('user').setDescription('User to ban').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false))
    .addIntegerOption(o => o.setName('delete_days').setDescription('Days of messages to delete (0-7)').setRequired(false)
      .setMinValue(0).setMaxValue(7)),

  new SlashCommandBuilder().setName('unban')
    .setDescription('Unban a user by ID')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption(o => o.setName('user_id').setDescription('Discord user ID to unban').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)),

  new SlashCommandBuilder().setName('purge')
    .setDescription('Bulk delete messages in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption(o => o.setName('count').setDescription('Number of messages to delete (1-100)').setRequired(true)
      .setMinValue(1).setMaxValue(100)),

  new SlashCommandBuilder().setName('slowmode')
    .setDescription('Set slowmode on this channel (0 to disable)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addIntegerOption(o => o.setName('seconds').setDescription('Slowmode in seconds (0 = off)').setRequired(true)
      .setMinValue(0).setMaxValue(21600)),

  new SlashCommandBuilder().setName('lock')
    .setDescription('Lock this channel — members cannot send messages')
    .setDefaultMemberPermissions(MOD)
    .addStringOption(o => o.setName('reason').setDescription('Reason for lock').setRequired(false)),

  new SlashCommandBuilder().setName('unlock')
    .setDescription('Unlock this channel — restore send permission')
    .setDefaultMemberPermissions(MOD),

  new SlashCommandBuilder().setName('modnote')
    .setDescription('Add a private mod note to a member (stored in bot only)')
    .setDefaultMemberPermissions(MOD)
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
    .addStringOption(o => o.setName('note').setDescription('Note text').setRequired(true)),

  // ── MARKETING ─────────────────────────────────────────────────────────────

  new SlashCommandBuilder().setName('announce')
    .setDescription('Post a branded announcement to #announcements')
    .setDefaultMemberPermissions(ADMIN)
    .addStringOption(o => o.setName('message').setDescription('Announcement body').setRequired(true))
    .addStringOption(o => o.setName('title').setDescription('Embed title (optional)').setRequired(false))
    .addStringOption(o => o.setName('ping').setDescription('Ping role before embed: everyone, here, or none')
      .setRequired(false).addChoices(
        { name: '@everyone', value: '@everyone' },
        { name: '@here',     value: '@here'     },
        { name: 'none',      value: 'none'      },
      )),

  new SlashCommandBuilder().setName('dm-tier')
    .setDescription('DM all members of a specific Aurevon tier')
    .setDefaultMemberPermissions(ADMIN)
    .addStringOption(o => o.setName('tier').setDescription('Tier to target').setRequired(true).addChoices(
      { name: '001 Genesis (Monthly)',     value: 'monthly'   },
      { name: '004 Chrome (Lifetime)',     value: 'lifetime'  },
      { name: 'Aurevon Insider',           value: 'product_a' },
      { name: 'Aurevon Ember',             value: 'product_b' },
      { name: 'Obsidian Executive',        value: 'product_c' },
    ))
    .addStringOption(o => o.setName('message').setDescription('DM message body').setRequired(true))
    .addStringOption(o => o.setName('subject').setDescription('Message subject/title (optional)').setRequired(false)),

  new SlashCommandBuilder().setName('promo')
    .setDescription('Broadcast a promo code announcement to #announcements')
    .setDefaultMemberPermissions(ADMIN)
    .addStringOption(o => o.setName('code').setDescription('Promo code (e.g. LAUNCH25)').setRequired(true))
    .addStringOption(o => o.setName('description').setDescription('What the code gives (e.g. 25% off Full Package)').setRequired(true))
    .addStringOption(o => o.setName('expires').setDescription('Expiry info (e.g. "Ends Friday" or leave blank)').setRequired(false)),

  new SlashCommandBuilder().setName('poll')
    .setDescription('Create a reaction-based poll in this channel')
    .setDefaultMemberPermissions(MOD)
    .addStringOption(o => o.setName('question').setDescription('Poll question').setRequired(true))
    .addStringOption(o => o.setName('option1').setDescription('Option 1').setRequired(true))
    .addStringOption(o => o.setName('option2').setDescription('Option 2').setRequired(true))
    .addStringOption(o => o.setName('option3').setDescription('Option 3 (optional)').setRequired(false))
    .addStringOption(o => o.setName('option4').setDescription('Option 4 (optional)').setRequired(false)),

  // ── AUTHORIZATION & VERIFICATION ─────────────────────────────────────────

  new SlashCommandBuilder().setName('sync-member')
    .setDescription('Assign correct tier role from Airtable by purchase email')
    .setDefaultMemberPermissions(ADMIN)
    .addStringOption(o => o.setName('email').setDescription("Member's purchase email").setRequired(true)),

  new SlashCommandBuilder().setName('revoke-member')
    .setDescription('Strip all Aurevon managed roles from a Discord member')
    .setDefaultMemberPermissions(ADMIN)
    .addUserOption(o => o.setName('user').setDescription('Member to revoke').setRequired(true)),

  new SlashCommandBuilder().setName('sync-all')
    .setDescription('Batch-sync all pending Airtable members to their Discord roles')
    .setDefaultMemberPermissions(ADMIN),

  new SlashCommandBuilder().setName('verify-member')
    .setDescription('Force-link a Discord user to a purchase email in Airtable')
    .setDefaultMemberPermissions(ADMIN)
    .addUserOption(o => o.setName('user').setDescription('Discord member').setRequired(true))
    .addStringOption(o => o.setName('email').setDescription('Purchase email').setRequired(true)),

  new SlashCommandBuilder().setName('welcome-dm')
    .setDescription('Re-send the Aurevon verification DM to a member')
    .setDefaultMemberPermissions(ADMIN)
    .addUserOption(o => o.setName('user').setDescription('Discord member').setRequired(true)),

  // ── ROLE MANAGEMENT ───────────────────────────────────────────────────────

  new SlashCommandBuilder().setName('add-role')
    .setDescription('Add a role to a member')
    .setDefaultMemberPermissions(ADMIN)
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
    .addRoleOption(o => o.setName('role').setDescription('Role to add').setRequired(true)),

  new SlashCommandBuilder().setName('remove-role')
    .setDescription('Remove a role from a member')
    .setDefaultMemberPermissions(ADMIN)
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
    .addRoleOption(o => o.setName('role').setDescription('Role to remove').setRequired(true)),

  new SlashCommandBuilder().setName('role-info')
    .setDescription('Show details about a role')
    .setDefaultMemberPermissions(MOD)
    .addRoleOption(o => o.setName('role').setDescription('Role to inspect').setRequired(true)),

  new SlashCommandBuilder().setName('create-role')
    .setDescription('Create a new server role')
    .setDefaultMemberPermissions(ADMIN)
    .addStringOption(o => o.setName('name').setDescription('Role name').setRequired(true))
    .addStringOption(o => o.setName('color').setDescription('Hex color (e.g. #C8A96E)').setRequired(false))
    .addBooleanOption(o => o.setName('hoist').setDescription('Show separately in member list?').setRequired(false)),

  // ── SERVER MANAGEMENT ─────────────────────────────────────────────────────

  new SlashCommandBuilder().setName('setup-server')
    .setDescription('Scaffold the full Aurevon Ventures channel/role structure')
    .setDefaultMemberPermissions(ADMIN),

  new SlashCommandBuilder().setName('create-channel')
    .setDescription('Create a new channel in the server')
    .setDefaultMemberPermissions(ADMIN)
    .addStringOption(o => o.setName('name').setDescription('Channel name').setRequired(true))
    .addStringOption(o => o.setName('type').setDescription('Channel type').setRequired(false)
      .addChoices(
        { name: 'Text',  value: 'text'  },
        { name: 'Voice', value: 'voice' },
      ))
    .addStringOption(o => o.setName('category').setDescription('Category name to place it in').setRequired(false)),

  new SlashCommandBuilder().setName('server-info')
    .setDescription('Rich overview of the Aurevon Ventures server'),

  new SlashCommandBuilder().setName('set-topic')
    .setDescription('Set this channel\'s topic')
    .setDefaultMemberPermissions(ADMIN)
    .addStringOption(o => o.setName('topic').setDescription('New topic text').setRequired(true)),

  new SlashCommandBuilder().setName('event')
    .setDescription('Manage Aurevon scheduled events')
    .setDefaultMemberPermissions(ADMIN)
    .addSubcommand(s => s.setName('create')
      .setDescription('Create a scheduled voice event')
      .addStringOption(o => o.setName('title').setDescription('Event title').setRequired(true))
      .addStringOption(o => o.setName('description').setDescription('Event description').setRequired(true))
      .addStringOption(o => o.setName('start_time').setDescription('ISO 8601 — e.g. 2025-06-01T18:00:00Z').setRequired(true))
      .addStringOption(o => o.setName('channel').setDescription('Voice channel name').setRequired(false)
        .addChoices(
          { name: 'Deal Room',        value: 'Deal Room'        },
          { name: 'Operator Suite',   value: 'Operator Suite'   },
          { name: 'Genesis War Room', value: 'Genesis War Room' },
          { name: 'General Lounge',   value: 'General Lounge'   },
        )))
    .addSubcommand(s => s.setName('list')
      .setDescription('List all upcoming scheduled events')),

  // ── TICKET SYSTEM ─────────────────────────────────────────────────────────

  new SlashCommandBuilder().setName('ticket-setup')
    .setDescription('Post the support ticket panel in this channel')
    .setDefaultMemberPermissions(ADMIN),

  new SlashCommandBuilder().setName('close-ticket')
    .setDescription('Close and archive the current support ticket')
    .setDefaultMemberPermissions(MOD),

  // ── ANALYTICS ─────────────────────────────────────────────────────────────

  new SlashCommandBuilder().setName('stats')
    .setDescription('Live Aurevon Operators server stats by tier')
    .setDefaultMemberPermissions(MOD),

  new SlashCommandBuilder().setName('boost-stats')
    .setDescription('Server boost level, booster count, and unlock progress')
    .setDefaultMemberPermissions(MOD),

  new SlashCommandBuilder().setName('lookup')
    .setDescription('Look up a member profile from Airtable')
    .setDefaultMemberPermissions(ADMIN)
    .addStringOption(o => o.setName('email').setDescription("Member's purchase email").setRequired(false))
    .addUserOption(o => o.setName('user').setDescription('Discord member').setRequired(false)),

  new SlashCommandBuilder().setName('member-report')
    .setDescription('Full member report — Discord info + Airtable data + role status')
    .setDefaultMemberPermissions(ADMIN)
    .addUserOption(o => o.setName('user').setDescription('Discord member').setRequired(true)),

].map(c => c.toJSON());

// ── Client ────────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildScheduledEvents,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildPresences,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

// ── Command registration ──────────────────────────────────────────────────────

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: COMMANDS });
  console.log(`[Bot] ✅  ${COMMANDS.length} commands registered (guild-scoped)`);
}

// ═════════════════════════════════════════════════════════════════════════════
//  COMMAND HANDLERS
// ═════════════════════════════════════════════════════════════════════════════

// ── /warn ─────────────────────────────────────────────────────────────────────

async function cmdWarn(i) {
  await i.deferReply({ ephemeral: true });
  const target = i.options.getUser('user');
  const reason = i.options.getString('reason');
  const count  = addWarn(target.id, reason, i.user.tag);

  const embed = buildModEmbed('warn', i.user, target, reason, { 'Warning #': count });
  await log(i.guild, 'mod-actions', { embeds: [embed] });

  target.send({
    embeds: [redEmbed(`⚠️  Warning from Aurevon Ventures`)
      .setDescription(`You have received a formal warning.\n\n**Reason:** ${reason}\n**Warning #:** ${count}`)
      .addFields({ name: 'Need help?', value: 'Reply to a moderator or open a support ticket.', inline: false })],
  }).catch(() => {});

  return i.editReply({ content: `✅  Warning #${count} issued to <@${target.id}>.`, embeds: [embed] });
}

// ── /warnings ─────────────────────────────────────────────────────────────────

async function cmdWarnings(i) {
  await i.deferReply({ ephemeral: true });
  const target = i.options.getUser('user');
  const list   = getWarns(target.id);

  if (!list.length) return i.editReply(`✅  <@${target.id}> has no warnings.`);

  const embed = goldEmbed(`⚠️  Warnings — ${target.tag}`)
    .setDescription(list.map((w, n) => `**${n + 1}.** ${w.reason}\n  ↳ by ${w.mod} — <t:${Math.floor(new Date(w.ts) / 1000)}:R>`).join('\n\n'));

  return i.editReply({ embeds: [embed] });
}

// ── /clearwarnings ────────────────────────────────────────────────────────────

async function cmdClearWarnings(i) {
  await i.deferReply({ ephemeral: true });
  const target = i.options.getUser('user');
  const before = getWarns(target.id).length;
  clearWarns(target.id);
  await log(i.guild, 'mod-actions', {
    embeds: [buildModEmbed('note', i.user, target, `Cleared ${before} warning(s)`)],
  });
  return i.editReply(`✅  Cleared ${before} warning(s) for <@${target.id}>.`);
}

// ── /timeout ──────────────────────────────────────────────────────────────────

async function cmdTimeout(i) {
  await i.deferReply({ ephemeral: true });
  const target  = i.options.getUser('user');
  const minutes = i.options.getInteger('minutes');
  const reason  = i.options.getString('reason') ?? 'No reason provided';

  let gm;
  try { gm = await i.guild.members.fetch(target.id); }
  catch { return i.editReply(`❌  <@${target.id}> is not in this server.`); }

  const until = new Date(Date.now() + minutes * 60_000);
  await gm.timeout(until, reason);

  const embed = buildModEmbed('timeout', i.user, target, reason, { Duration: `${minutes} min`, Until: `<t:${Math.floor(until / 1000)}:R>` });
  await log(i.guild, 'mod-actions', { embeds: [embed] });
  return i.editReply({ content: `✅  <@${target.id}> timed out for ${minutes} min.`, embeds: [embed] });
}

// ── /kick ─────────────────────────────────────────────────────────────────────

async function cmdKick(i) {
  await i.deferReply({ ephemeral: true });
  const target = i.options.getUser('user');
  const reason = i.options.getString('reason') ?? 'No reason provided';

  let gm;
  try { gm = await i.guild.members.fetch(target.id); }
  catch { return i.editReply(`❌  <@${target.id}> is not in this server.`); }

  await gm.send({ embeds: [redEmbed('👢  You have been kicked')
    .setDescription(`You were kicked from **Aurevon Ventures**.\n\n**Reason:** ${reason}`)] }).catch(() => {});

  await gm.kick(reason);

  const embed = buildModEmbed('kick', i.user, target, reason);
  await log(i.guild, 'mod-actions', { embeds: [embed] });
  return i.editReply({ content: `✅  <@${target.id}> kicked.`, embeds: [embed] });
}

// ── /ban ──────────────────────────────────────────────────────────────────────

async function cmdBan(i) {
  await i.deferReply({ ephemeral: true });
  const target      = i.options.getUser('user');
  const reason      = i.options.getString('reason') ?? 'No reason provided';
  const deleteDays  = i.options.getInteger('delete_days') ?? 0;

  const gm = await i.guild.members.fetch(target.id).catch(() => null);
  if (gm) {
    await gm.send({ embeds: [redEmbed('🔨  You have been banned')
      .setDescription(`You were banned from **Aurevon Ventures**.\n\n**Reason:** ${reason}\n\nIf you believe this is an error, email support@aurevongroup.com`)] }).catch(() => {});
  }

  await i.guild.members.ban(target.id, { reason, deleteMessageDays: deleteDays });

  const embed = buildModEmbed('ban', i.user, target, reason, { 'Messages Deleted': `${deleteDays}d` });
  await log(i.guild, 'mod-actions', { embeds: [embed] });
  return i.editReply({ content: `✅  <@${target.id}> banned.`, embeds: [embed] });
}

// ── /unban ────────────────────────────────────────────────────────────────────

async function cmdUnban(i) {
  await i.deferReply({ ephemeral: true });
  const userId = i.options.getString('user_id');
  const reason = i.options.getString('reason') ?? 'No reason provided';

  let user;
  try {
    await i.guild.members.unban(userId, reason);
    user = await client.users.fetch(userId).catch(() => null);
  } catch (e) {
    return i.editReply(`❌  Could not unban \`${userId}\`: ${e.message}`);
  }

  const embed = goldEmbed('✅  Unbanned')
    .addFields(
      { name: 'User',      value: user ? `${user.tag} (<@${userId}>)` : userId, inline: true },
      { name: 'Moderator', value: `<@${i.user.id}>`,                            inline: true },
      { name: 'Reason',    value: reason,                                       inline: false },
    );

  await log(i.guild, 'mod-actions', { embeds: [embed] });
  return i.editReply({ content: `✅  Unbanned user.`, embeds: [embed] });
}

// ── /purge ────────────────────────────────────────────────────────────────────

async function cmdPurge(i) {
  await i.deferReply({ ephemeral: true });
  const count = i.options.getInteger('count');

  let deleted;
  try {
    const msgs = await i.channel.bulkDelete(count, true);
    deleted = msgs.size;
  } catch (e) {
    return i.editReply(`❌  Purge failed: ${e.message} (messages older than 14 days cannot be bulk deleted)`);
  }

  await log(i.guild, 'mod-actions', {
    embeds: [goldEmbed('🗑️  Messages Purged')
      .addFields(
        { name: 'Channel',   value: `<#${i.channel.id}>`, inline: true },
        { name: 'Deleted',   value: String(deleted),      inline: true },
        { name: 'By',        value: `<@${i.user.id}>`,    inline: true },
      )],
  });

  return i.editReply(`✅  Deleted ${deleted} message${deleted === 1 ? '' : 's'}.`);
}

// ── /slowmode ─────────────────────────────────────────────────────────────────

async function cmdSlowmode(i) {
  await i.deferReply({ ephemeral: true });
  const secs = i.options.getInteger('seconds');
  await i.channel.setRateLimitPerUser(secs);
  return i.editReply(secs === 0 ? `✅  Slowmode disabled in <#${i.channel.id}>.` : `✅  Slowmode set to ${secs}s in <#${i.channel.id}>.`);
}

// ── /lock ─────────────────────────────────────────────────────────────────────

async function cmdLock(i) {
  await i.deferReply({ ephemeral: true });
  const reason = i.options.getString('reason') ?? 'Channel locked by moderator';
  await i.channel.permissionOverwrites.edit(i.guild.roles.everyone, { SendMessages: false });
  await i.channel.send({ embeds: [redEmbed('🔒  Channel Locked').setDescription(reason)] });
  await log(i.guild, 'mod-actions', {
    embeds: [goldEmbed('🔒  Channel Locked').addFields(
      { name: 'Channel', value: `<#${i.channel.id}>`, inline: true },
      { name: 'By',      value: `<@${i.user.id}>`,   inline: true },
      { name: 'Reason',  value: reason,               inline: false },
    )],
  });
  return i.editReply('✅  Channel locked.');
}

// ── /unlock ───────────────────────────────────────────────────────────────────

async function cmdUnlock(i) {
  await i.deferReply({ ephemeral: true });
  await i.channel.permissionOverwrites.edit(i.guild.roles.everyone, { SendMessages: null });
  await i.channel.send({ embeds: [goldEmbed('🔓  Channel Unlocked').setDescription('This channel is now open.')] });
  return i.editReply('✅  Channel unlocked.');
}

// ── /modnote ──────────────────────────────────────────────────────────────────

async function cmdModnote(i) {
  await i.deferReply({ ephemeral: true });
  const target = i.options.getUser('user');
  const note   = i.options.getString('note');
  // Re-use warn store for notes, prefixed for clarity
  addWarn(target.id, `[MOD NOTE] ${note}`, i.user.tag);
  await log(i.guild, 'mod-actions', {
    embeds: [buildModEmbed('note', i.user, target, note)],
  });
  return i.editReply(`✅  Note added for <@${target.id}>.`);
}

// ── /announce ─────────────────────────────────────────────────────────────────

async function cmdAnnounce(i) {
  await i.deferReply({ ephemeral: true });
  const message = i.options.getString('message');
  const title   = i.options.getString('title') ?? '📢  Aurevon Update';
  const ping    = i.options.getString('ping')  ?? 'none';

  const announceCh = ch(i.guild, 'announcements');
  if (!announceCh) return i.editReply('❌  #announcements channel not found. Run `/setup-server` first.');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Visit Aurevon').setStyle(ButtonStyle.Link).setURL(SITE_URL).setEmoji('🌐'),
  );

  const content = ping !== 'none' ? ping : undefined;
  await announceCh.send({ content, embeds: [goldEmbed(title).setDescription(message)], components: [row] });
  return i.editReply(`✅  Announced in <#${announceCh.id}>.`);
}

// ── /dm-tier ──────────────────────────────────────────────────────────────────

async function cmdDmTier(i) {
  await i.deferReply({ ephemeral: true });
  const tierKey = i.options.getString('tier');
  const message = i.options.getString('message');
  const subject = i.options.getString('subject') ?? `📩  Message from Aurevon Ventures`;
  const roleId  = roleIdFor(tierKey);

  if (!roleId) {
    return i.editReply(`❌  Role ID for **${TIER_ROLES[tierKey]?.label}** is not configured. Set \`${TIER_ROLES[tierKey]?.env}\` in your .env.`);
  }

  const members = (await i.guild.members.fetch()).filter(m => m.roles.cache.has(roleId) && !m.user.bot);
  if (!members.size) return i.editReply(`⚠️  No members found with the **${TIER_ROLES[tierKey]?.label}** role.`);

  await i.editReply(`⏳  Sending DMs to ${members.size} members... this may take a moment.`);

  let sent = 0, failed = 0;
  for (const [, m] of members) {
    const success = await m.user.send({
      embeds: [goldEmbed(subject).setDescription(message)
        .addFields({ name: '🌐  Visit Aurevon', value: SITE_URL, inline: false })],
    }).then(() => true).catch(() => false);
    if (success) sent++; else failed++;
    await new Promise(r => setTimeout(r, 400)); // rate limit buffer
  }

  await log(i.guild, 'bot-commands', {
    embeds: [goldEmbed('📨  DM Campaign Sent')
      .addFields(
        { name: 'Tier',   value: TIER_ROLES[tierKey]?.label ?? tierKey, inline: true },
        { name: '✅ Sent', value: String(sent),                          inline: true },
        { name: '❌ Failed', value: String(failed),                      inline: true },
        { name: 'Subject', value: subject,                              inline: false },
      )],
  });

  return i.editReply(`✅  DM campaign complete — **${sent}** sent, **${failed}** failed (DMs disabled).`);
}

// ── /promo ────────────────────────────────────────────────────────────────────

async function cmdPromo(i) {
  await i.deferReply({ ephemeral: true });
  const code    = i.options.getString('code').toUpperCase();
  const desc    = i.options.getString('description');
  const expires = i.options.getString('expires');

  const announceCh = ch(i.guild, 'announcements');
  if (!announceCh) return i.editReply('❌  #announcements not found.');

  const embed = new EmbedBuilder()
    .setColor(0xFEE75C)
    .setTitle('🎟️  Exclusive Member Promo')
    .addFields(
      { name: '🏷️  Code',        value: `\`${code}\``,                 inline: true  },
      { name: '🎁  What You Get', value: desc,                           inline: false },
      { name: '🌐  Redeem At',   value: `[${SITE_URL}](${SITE_URL})`, inline: true  },
    )
    .setFooter({ text: expires ? `Expires: ${expires}` : 'Limited time offer — Aurevon Ventures LLC' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Claim Offer →').setStyle(ButtonStyle.Link).setURL(SITE_URL).setEmoji('🎟️'),
  );

  await announceCh.send({ embeds: [embed], components: [row] });
  return i.editReply(`✅  Promo \`${code}\` announced in <#${announceCh.id}>.`);
}

// ── /poll ─────────────────────────────────────────────────────────────────────

async function cmdPoll(i) {
  await i.deferReply({ ephemeral: true });
  const question = i.options.getString('question');
  const opts = [
    i.options.getString('option1'),
    i.options.getString('option2'),
    i.options.getString('option3'),
    i.options.getString('option4'),
  ].filter(Boolean);

  const EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
  const desc = opts.map((o, n) => `${EMOJIS[n]}  ${o}`).join('\n\n');

  const embed = goldEmbed('📊  ' + question)
    .setDescription(desc)
    .setFooter({ text: 'React to vote! | Aurevon Ventures LLC' });

  const pollMsg = await i.channel.send({ embeds: [embed] });
  for (let n = 0; n < opts.length; n++) await pollMsg.react(EMOJIS[n]);

  return i.editReply('✅  Poll posted.');
}

// ── /sync-member ──────────────────────────────────────────────────────────────

async function cmdSyncMember(i) {
  await i.deferReply({ ephemeral: true });
  const email = i.options.getString('email').toLowerCase().trim();

  if (!AT_PAT) return i.editReply('❌  Airtable not configured — set AIRTABLE_PAT in .env');

  const [member, mint] = await Promise.all([findMember(email), findMint(email)]);
  if (!mint) return i.editReply(`❌  No active NFT mint found for \`${email}\`.`);

  const nftType = mint.fields['NFT Type'] ?? '';
  const roleId  = resolveRoleFromNft(nftType);
  if (!roleId)  return i.editReply(`❌  No role configured for NFT type: **${nftType}**`);

  const discordId = member?.fields?.['Discord ID'];
  if (!discordId) return i.editReply(`⚠️  No Discord ID linked for \`${email}\`. Member must complete OAuth at ${SITE_URL}/member-claim.html`);

  const gm = await i.guild.members.fetch(discordId).catch(() => null);
  if (!gm) return i.editReply(`❌  Discord user \`${discordId}\` is not in this server.`);

  await gm.roles.add(roleId);

  if (member) {
    await atPatch(AT_MEMBERS, member.id, { 'Discord Sync Status': 'synced', 'Discord Sync At': new Date().toISOString() });
  }

  const role  = i.guild.roles.cache.get(roleId);
  const embed = goldEmbed('✅  Member Synced')
    .addFields(
      { name: 'Email',   value: email,               inline: true },
      { name: 'Discord', value: `<@${discordId}>`,   inline: true },
      { name: 'Role',    value: role?.name ?? roleId, inline: true },
      { name: 'NFT',     value: nftType,             inline: true },
    );

  await log(i.guild, 'role-logs', { embeds: [embed] });
  return i.editReply({ embeds: [embed] });
}

// ── /revoke-member ────────────────────────────────────────────────────────────

async function cmdRevokeMember(i) {
  await i.deferReply({ ephemeral: true });
  const target = i.options.getUser('user');
  const gm     = await i.guild.members.fetch(target.id).catch(() => null);
  if (!gm) return i.editReply(`❌  <@${target.id}> is not in this server.`);

  const managed  = getManagedRoleIds();
  const toRemove = gm.roles.cache.filter(r => managed.includes(r.id));
  if (!toRemove.size) return i.editReply(`⚠️  <@${target.id}> has no managed Aurevon roles.`);

  await gm.roles.remove([...toRemove.keys()]);

  const embed = goldEmbed('🚫  Roles Revoked')
    .addFields(
      { name: 'Member',        value: `<@${target.id}>`,                              inline: true  },
      { name: 'Roles Removed', value: [...toRemove.values()].map(r => r.name).join(', '), inline: false },
    );

  await log(i.guild, 'role-logs', { embeds: [embed] });
  return i.editReply({ embeds: [embed] });
}

// ── /sync-all ─────────────────────────────────────────────────────────────────

async function cmdSyncAll(i) {
  await i.deferReply({ ephemeral: true });
  if (!AT_PAT) return i.editReply('❌  Airtable not configured.');

  const pending = await atFetch(
    AT_MEMBERS,
    `AND({Discord ID}!="",OR({Discord Sync Status}="pending",{Discord Sync Status}="failed",{Discord Sync Status}=""))`
  );
  if (!pending.length) return i.editReply('✅  No members pending sync.');

  let synced = 0, skipped = 0, failed = 0;
  for (const rec of pending) {
    const email     = rec.fields['Email'] ?? '';
    const discordId = rec.fields['Discord ID'];
    if (!email || !discordId) { skipped++; continue; }

    try {
      const mint = await findMint(email);
      if (!mint) { skipped++; continue; }

      const roleId = resolveRoleFromNft(mint.fields['NFT Type'] ?? '');
      if (!roleId) { skipped++; continue; }

      const gm = await i.guild.members.fetch(discordId).catch(() => null);
      if (!gm) { skipped++; continue; }

      await gm.roles.add(roleId);
      await atPatch(AT_MEMBERS, rec.id, { 'Discord Sync Status': 'synced', 'Discord Sync At': new Date().toISOString() });
      synced++;
    } catch {
      failed++;
    }
  }

  const embed = goldEmbed('🔄  Sync-All Complete')
    .addFields(
      { name: '✅ Synced',   value: String(synced),  inline: true },
      { name: '⏭️ Skipped',  value: String(skipped), inline: true },
      { name: '❌ Failed',   value: String(failed),  inline: true },
    );

  await log(i.guild, 'role-logs', { embeds: [embed] });
  return i.editReply({ embeds: [embed] });
}

// ── /verify-member ────────────────────────────────────────────────────────────

async function cmdVerifyMember(i) {
  await i.deferReply({ ephemeral: true });
  const target = i.options.getUser('user');
  const email  = i.options.getString('email').toLowerCase().trim();

  if (!AT_PAT) return i.editReply('❌  Airtable not configured.');

  const member = await findMember(email);
  const fields = {
    'Discord ID':       target.id,
    'Discord Username': target.tag,
    'Discord Linked At': new Date().toISOString(),
    'Discord Sync Status': 'pending',
    'Active': true,
  };

  if (member) {
    await atPatch(AT_MEMBERS, member.id, fields);
  }

  const embed = goldEmbed('🔗  Member Linked')
    .addFields(
      { name: 'Email',   value: email,             inline: true },
      { name: 'Discord', value: `<@${target.id}>`, inline: true },
    )
    .setDescription('Run `/sync-member` to assign their tier role.');

  await log(i.guild, 'role-logs', { embeds: [embed] });
  return i.editReply({ content: `✅  Linked \`${email}\` → <@${target.id}>. Run \`/sync-member\` to assign role.`, embeds: [embed] });
}

// ── /welcome-dm ───────────────────────────────────────────────────────────────

async function cmdWelcomeDm(i) {
  await i.deferReply({ ephemeral: true });
  const target = i.options.getUser('user');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Member Portal').setStyle(ButtonStyle.Link).setURL(`${SITE_URL}/member-claim.html`).setEmoji('🔑'),
    new ButtonBuilder().setLabel('Visit Aurevon').setStyle(ButtonStyle.Link).setURL(SITE_URL).setEmoji('🌐'),
  );
  const ok = await target.send({ embeds: [buildWelcomeDm()], components: [row] }).then(() => true).catch(() => false);
  return i.editReply(ok ? `✅  Welcome DM sent to <@${target.id}>.` : `⚠️  Could not DM <@${target.id}> — DMs may be disabled.`);
}

// ── /add-role ─────────────────────────────────────────────────────────────────

async function cmdAddRole(i) {
  await i.deferReply({ ephemeral: true });
  const target = i.options.getUser('user');
  const role   = i.options.getRole('role');
  const gm     = await i.guild.members.fetch(target.id).catch(() => null);
  if (!gm) return i.editReply(`❌  <@${target.id}> is not in this server.`);
  if (gm.roles.cache.has(role.id)) return i.editReply(`⚠️  <@${target.id}> already has **${role.name}**.`);
  await gm.roles.add(role);
  await log(i.guild, 'role-logs', { embeds: [goldEmbed('➕  Role Added').addFields(
    { name: 'Member', value: `<@${target.id}>`, inline: true },
    { name: 'Role',   value: role.name,         inline: true },
    { name: 'By',     value: `<@${i.user.id}>`, inline: true },
  )] });
  return i.editReply(`✅  Added **${role.name}** to <@${target.id}>.`);
}

// ── /remove-role ──────────────────────────────────────────────────────────────

async function cmdRemoveRole(i) {
  await i.deferReply({ ephemeral: true });
  const target = i.options.getUser('user');
  const role   = i.options.getRole('role');
  const gm     = await i.guild.members.fetch(target.id).catch(() => null);
  if (!gm) return i.editReply(`❌  <@${target.id}> is not in this server.`);
  if (!gm.roles.cache.has(role.id)) return i.editReply(`⚠️  <@${target.id}> does not have **${role.name}**.`);
  await gm.roles.remove(role);
  await log(i.guild, 'role-logs', { embeds: [goldEmbed('➖  Role Removed').addFields(
    { name: 'Member', value: `<@${target.id}>`, inline: true },
    { name: 'Role',   value: role.name,         inline: true },
    { name: 'By',     value: `<@${i.user.id}>`, inline: true },
  )] });
  return i.editReply(`✅  Removed **${role.name}** from <@${target.id}>.`);
}

// ── /role-info ────────────────────────────────────────────────────────────────

async function cmdRoleInfo(i) {
  await i.deferReply({ ephemeral: true });
  const role    = i.options.getRole('role');
  const members = (await i.guild.members.fetch()).filter(m => m.roles.cache.has(role.id));

  const embed = new EmbedBuilder()
    .setColor(role.color || GOLD)
    .setTitle(`🏷️  Role: ${role.name}`)
    .addFields(
      { name: 'ID',          value: role.id,                             inline: true  },
      { name: 'Color',       value: role.hexColor,                       inline: true  },
      { name: 'Members',     value: String(members.size),               inline: true  },
      { name: 'Hoisted',     value: role.hoist ? 'Yes' : 'No',          inline: true  },
      { name: 'Mentionable', value: role.mentionable ? 'Yes' : 'No',    inline: true  },
      { name: 'Position',    value: String(role.position),              inline: true  },
      { name: 'Created',     value: `<t:${Math.floor(role.createdTimestamp / 1000)}:D>`, inline: false },
    )
    .setTimestamp();

  return i.editReply({ embeds: [embed] });
}

// ── /create-role ──────────────────────────────────────────────────────────────

async function cmdCreateRole(i) {
  await i.deferReply({ ephemeral: true });
  const name  = i.options.getString('name');
  const color = i.options.getString('color') ?? null;
  const hoist = i.options.getBoolean('hoist') ?? false;

  const role = await i.guild.roles.create({ name, color, hoist, reason: `Created by ${i.user.tag}` });
  await log(i.guild, 'bot-commands', { embeds: [goldEmbed('🎭  Role Created').addFields(
    { name: 'Name',  value: role.name,         inline: true },
    { name: 'ID',    value: role.id,           inline: true },
    { name: 'Color', value: role.hexColor,     inline: true },
    { name: 'By',    value: `<@${i.user.id}>`, inline: false },
  )] });
  return i.editReply(`✅  Role **${role.name}** created (ID: \`${role.id}\`).`);
}

// ── /setup-server ─────────────────────────────────────────────────────────────

async function cmdSetupServer(i) {
  await i.deferReply({ ephemeral: true });
  const { guild } = i;

  const structure = [
    {
      name: '── WELCOME ──', type: 'category', channels: [
        { name: 'rules',          type: ChannelType.GuildText,  topic: 'Read before doing anything else.' },
        { name: 'announcements',  type: ChannelType.GuildText,  topic: 'Official Aurevon announcements.' },
        { name: 'welcome',        type: ChannelType.GuildText,  topic: 'Introductions welcome here.' },
      ],
    },
    {
      name: '── VERIFICATION ──', type: 'category', channels: [
        { name: 'verify',         type: ChannelType.GuildText, topic: 'Click the button below to access your membership.' },
        { name: 'bot-commands',   type: ChannelType.GuildText, topic: 'Bot status and slash command output.' },
      ],
    },
    {
      name: '── COMMUNITY ──', type: 'category', channels: [
        { name: 'general',        type: ChannelType.GuildText, topic: 'General member discussion.' },
        { name: 'deal-flow',      type: ChannelType.GuildText, topic: 'Submit and discuss deal opportunities.' },
        { name: 'market-intel',   type: ChannelType.GuildText, topic: 'Market analysis and research.' },
        { name: 'resources',      type: ChannelType.GuildText, topic: 'Templates, tools, and guides.' },
      ],
    },
    {
      name: '── OPERATORS ONLY ──', type: 'category', channels: [
        { name: 'operator-lounge', type: ChannelType.GuildText,  topic: 'Paid members only.' },
        { name: 'deal-reviews',    type: ChannelType.GuildText,  topic: 'Full Package deal review threads.' },
        { name: 'deal-room',       type: ChannelType.GuildVoice, topic: '' },
        { name: 'operator-suite',  type: ChannelType.GuildVoice, topic: '' },
      ],
    },
    {
      name: '── STAFF ──', type: 'category', channels: [
        { name: 'mod-actions',    type: ChannelType.GuildText, topic: 'Moderation log — restricted.' },
        { name: 'role-logs',      type: ChannelType.GuildText, topic: 'Role assignment / removal log.' },
        { name: 'join-logs',      type: ChannelType.GuildText, topic: 'Member join and leave events.' },
        { name: 'audit-log',      type: ChannelType.GuildText, topic: 'Discord audit log events.' },
        { name: 'staff-lounge',   type: ChannelType.GuildText, topic: 'Staff discussion.' },
      ],
    },
    {
      name: '── SUPPORT ──', type: 'category', channels: [
        { name: 'open-a-ticket',  type: ChannelType.GuildText, topic: 'Use /ticket-setup to post the ticket panel here.' },
      ],
    },
  ];

  let created = 0;
  for (const cat of structure) {
    let catObj = guild.channels.cache.find(c => c.name === cat.name && c.type === ChannelType.GuildCategory);
    if (!catObj) {
      catObj = await guild.channels.create({ name: cat.name, type: ChannelType.GuildCategory }).catch(() => null);
    }
    for (const chanDef of cat.channels) {
      const exists = guild.channels.cache.find(c => c.name === chanDef.name);
      if (!exists) {
        await guild.channels.create({
          name: chanDef.name,
          type: chanDef.type,
          topic: chanDef.topic,
          parent: catObj?.id,
        }).catch(() => {});
        created++;
      }
    }
  }

  return i.editReply(`✅  Server structure applied — **${created}** new channels created. Existing channels were left untouched.`);
}

// ── /create-channel ───────────────────────────────────────────────────────────

async function cmdCreateChannel(i) {
  await i.deferReply({ ephemeral: true });
  const name     = i.options.getString('name').toLowerCase().replace(/\s+/g, '-');
  const typeStr  = i.options.getString('type') ?? 'text';
  const catName  = i.options.getString('category');
  const type     = typeStr === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText;

  const parent = catName
    ? i.guild.channels.cache.find(c => c.name.toLowerCase().includes(catName.toLowerCase()) && c.type === ChannelType.GuildCategory)?.id
    : undefined;

  const newCh = await i.guild.channels.create({ name, type, parent }).catch(e => ({ error: e.message }));
  if (newCh.error) return i.editReply(`❌  ${newCh.error}`);
  return i.editReply(`✅  Created <#${newCh.id}>.`);
}

// ── /server-info ──────────────────────────────────────────────────────────────

async function cmdServerInfo(i) {
  await i.deferReply();
  const { guild } = i;
  const members  = await guild.members.fetch();
  const humans   = members.filter(m => !m.user.bot).size;
  const bots     = members.filter(m => m.user.bot).size;

  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle(`📋  ${guild.name}`)
    .setThumbnail(guild.iconURL({ dynamic: true }))
    .addFields(
      { name: '👥 Members',    value: String(humans),                    inline: true },
      { name: '🤖 Bots',       value: String(bots),                     inline: true },
      { name: '🆔 ID',         value: guild.id,                         inline: true },
      { name: '📅 Created',    value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:D>`, inline: true },
      { name: '🔨 Owner',      value: `<@${guild.ownerId}>`,            inline: true },
      { name: '🚀 Boost Tier', value: `Level ${guild.premiumTier}`,     inline: true },
      { name: '💎 Boosters',   value: String(guild.premiumSubscriptionCount), inline: true },
      { name: '📺 Channels',   value: String(guild.channels.cache.size), inline: true },
      { name: '🎭 Roles',      value: String(guild.roles.cache.size),   inline: true },
    )
    .setFooter({ text: 'Aurevon Ventures LLC' })
    .setTimestamp();

  return i.editReply({ embeds: [embed] });
}

// ── /set-topic ────────────────────────────────────────────────────────────────

async function cmdSetTopic(i) {
  await i.deferReply({ ephemeral: true });
  const topic = i.options.getString('topic');
  await i.channel.setTopic(topic);
  return i.editReply(`✅  Topic updated.`);
}

// ── /event create + list ──────────────────────────────────────────────────────

async function cmdEventCreate(i) {
  await i.deferReply({ ephemeral: true });
  const title    = i.options.getString('title');
  const desc     = i.options.getString('description');
  const startRaw = i.options.getString('start_time');
  const chanName = i.options.getString('channel') ?? 'Deal Room';

  const startTime = new Date(startRaw);
  if (isNaN(startTime)) return i.editReply('❌  Invalid `start_time`. Use ISO 8601: `2025-06-01T18:00:00Z`');
  if (startTime < new Date()) return i.editReply('❌  `start_time` must be in the future.');

  const voiceCh = i.guild.channels.cache.find(c => c.name === chanName && c.type === ChannelType.GuildVoice);
  if (!voiceCh) return i.editReply(`❌  Voice channel **${chanName}** not found.`);

  const event = await i.guild.scheduledEvents.create({
    name: title, description: desc,
    scheduledStartTime: startTime,
    privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
    entityType:   GuildScheduledEventEntityType.Voice,
    channel:      voiceCh,
  });

  const embed = goldEmbed(`📅  Event Created: ${title}`)
    .setDescription(desc)
    .addFields(
      { name: '🎙️ Channel', value: voiceCh.name,                             inline: true },
      { name: '🕐 Starts',  value: `<t:${Math.floor(startTime / 1000)}:F>`, inline: true },
    );

  await log(i.guild, 'announcements', { embeds: [embed] });
  return i.editReply({ content: '✅  Event created and announced.', embeds: [embed] });
}

async function cmdEventList(i) {
  await i.deferReply({ ephemeral: true });
  const events = await i.guild.scheduledEvents.fetch();
  const upcoming = events.filter(e => e.status !== GuildScheduledEventStatus.Completed && e.status !== GuildScheduledEventStatus.Canceled);

  if (!upcoming.size) return i.editReply('📭  No upcoming events scheduled.');

  const embed = goldEmbed('📅  Upcoming Events');
  upcoming.forEach(e => {
    embed.addFields({
      name:  e.name,
      value: `<t:${Math.floor(e.scheduledStartTimestamp / 1000)}:F> — ${e.description?.slice(0, 80) ?? 'No description'}`,
      inline: false,
    });
  });

  return i.editReply({ embeds: [embed] });
}

// ── /ticket-setup ─────────────────────────────────────────────────────────────

async function cmdTicketSetup(i) {
  await i.deferReply({ ephemeral: true });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_open')
      .setLabel('🎫  Open a Support Ticket')
      .setStyle(ButtonStyle.Primary),
  );

  const embed = goldEmbed('🎫  Aurevon Support')
    .setDescription(
      'Need help with your membership, NFT, or a deal?\n\n' +
      'Click the button below to open a private support channel — a moderator will respond as soon as possible.'
    )
    .addFields(
      { name: '📋  Common questions', value: '`/member-claim` → verify membership\n`/sync-member` → fix role assignment\nEmail: support@aurevongroup.com', inline: false },
    );

  await i.channel.send({ embeds: [embed], components: [row] });
  return i.editReply('✅  Ticket panel posted.');
}

// ── /close-ticket ────────────────────────────────────────────────────────────

async function cmdCloseTicket(i) {
  await i.deferReply({ ephemeral: true });

  if (!openTickets.has(i.channel.id)) {
    return i.editReply('❌  This is not a ticket channel, or the ticket was already closed.');
  }

  const { userId } = openTickets.get(i.channel.id);
  openTickets.delete(i.channel.id);

  await i.channel.send({ embeds: [goldEmbed('🔒  Ticket Closed').setDescription(`Closed by <@${i.user.id}>. This channel will be deleted in 10 seconds.`)] });
  setTimeout(() => i.channel.delete().catch(() => {}), 10_000);

  await log(i.guild, 'mod-actions', {
    embeds: [goldEmbed('🎫  Ticket Closed').addFields(
      { name: 'Opened By', value: `<@${userId}>`,   inline: true },
      { name: 'Closed By', value: `<@${i.user.id}>`, inline: true },
    )],
  });

  return i.editReply('✅  Ticket closing in 10 seconds.');
}

// ── /stats ────────────────────────────────────────────────────────────────────

async function cmdStats(i) {
  await i.deferReply({ ephemeral: true });
  const members = await i.guild.members.fetch();
  const humans  = members.filter(m => !m.user.bot);

  const tierFields = Object.entries(TIER_ROLES).map(([, cfg]) => {
    const roleId = process.env[cfg.env];
    const count  = roleId ? members.filter(m => m.roles.cache.has(roleId)).size : 0;
    return { name: cfg.label, value: `**${count}**`, inline: true };
  });

  const verifiedCount = process.env.DISCORD_ROLE_VERIFIED
    ? humans.filter(m => m.roles.cache.has(process.env.DISCORD_ROLE_VERIFIED)).size
    : null;

  const embed = goldEmbed('📊  Aurevon Ventures — Live Stats')
    .addFields(
      { name: '👥 Total',    value: `**${humans.size}**`,                       inline: true },
      { name: '✅ Verified', value: `**${verifiedCount ?? '—'}**`,              inline: true },
      { name: '🚀 Boost Lvl', value: `**Level ${i.guild.premiumTier}**`,        inline: true },
      { name: '​',      value: '​',                                   inline: false },
      ...tierFields,
    );

  return i.editReply({ embeds: [embed] });
}

// ── /boost-stats ──────────────────────────────────────────────────────────────

async function cmdBoostStats(i) {
  await i.deferReply({ ephemeral: true });
  const { guild } = i;
  const THRESHOLDS = [
    { tier: 1, boosts: 2,  perks: '50MB uploads, +50 emoji, animated icon' },
    { tier: 2, boosts: 7,  perks: '100MB uploads, +100 emoji, server banner' },
    { tier: 3, boosts: 14, perks: '384kbps audio, +250 emoji, vanity URL' },
  ];
  const current = guild.premiumSubscriptionCount ?? 0;
  const tier    = guild.premiumTier ?? 0;
  const next    = THRESHOLDS.find(t => t.tier === tier + 1);

  const embed = new EmbedBuilder().setColor(0xFF73FA).setTitle('🚀  Server Boost Status')
    .addFields(
      { name: '📶 Boost Level',  value: `Level ${tier}`,                                                                           inline: true  },
      { name: '💎 Total Boosts', value: String(current),                                                                          inline: true  },
      { name: '📈 Next Goal',    value: next ? `${current}/${next.boosts} boosts → Level ${next.tier}` : '🏆 Max level reached', inline: false },
      { name: '🎁 Next Perks',   value: next?.perks ?? 'All Discord perks unlocked!',                                             inline: false },
    )
    .setThumbnail(guild.iconURL({ dynamic: true }))
    .setFooter({ text: 'Boost Aurevon Ventures to unlock more perks!' })
    .setTimestamp();

  return i.editReply({ embeds: [embed] });
}

// ── /lookup ───────────────────────────────────────────────────────────────────

async function cmdLookup(i) {
  await i.deferReply({ ephemeral: true });
  const email  = i.options.getString('email');
  const target = i.options.getUser('user');
  if (!email && !target) return i.editReply('❌  Provide `email` or `user`.');

  const lookupEmail = email?.toLowerCase().trim();
  let memberRec, mintRec;

  if (lookupEmail && AT_PAT) {
    [memberRec, mintRec] = await Promise.all([findMember(lookupEmail), findMint(lookupEmail)]);
  }

  const discordId = memberRec?.fields?.['Discord ID'] ?? target?.id;
  const gm        = discordId ? await i.guild.members.fetch(discordId).catch(() => null) : null;

  const embed = goldEmbed('🔍  Member Lookup')
    .addFields(
      { name: 'Email',        value: lookupEmail ?? '—',                                              inline: true  },
      { name: 'Discord',      value: gm ? `<@${discordId}>` : discordId ?? '—',                      inline: true  },
      { name: 'Joined Server',value: gm?.joinedAt ? `<t:${Math.floor(gm.joinedAt / 1000)}:D>` : '—', inline: true  },
      { name: 'Tier Roles',   value: gm ? gm.roles.cache.filter(r => getTierRoleIds().includes(r.id)).map(r => r.name).join(', ') || 'None' : '—', inline: false },
      { name: 'NFT Type',     value: mintRec?.fields?.['NFT Type'] ?? '—',                           inline: true  },
      { name: 'Mint Status',  value: mintRec?.fields?.['Mint Status'] ?? '—',                         inline: true  },
      { name: 'Sync Status',  value: memberRec?.fields?.['Discord Sync Status'] ?? '—',               inline: true  },
    );

  return i.editReply({ embeds: [embed] });
}

// ── /member-report ────────────────────────────────────────────────────────────

async function cmdMemberReport(i) {
  await i.deferReply({ ephemeral: true });
  const target = i.options.getUser('user');
  const gm     = await i.guild.members.fetch(target.id).catch(() => null);

  const warns  = getWarns(target.id);
  const tierRoles = gm ? gm.roles.cache.filter(r => getTierRoleIds().includes(r.id)).map(r => r.name) : [];
  const allRoles  = gm ? gm.roles.cache.filter(r => r.id !== i.guild.id).map(r => r.name) : [];

  const embed = goldEmbed(`📋  Member Report — ${target.tag}`)
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: '🆔 User ID',      value: target.id,                                          inline: true  },
      { name: '📅 Account',      value: `<t:${Math.floor(target.createdTimestamp / 1000)}:D>`, inline: true },
      { name: '📥 Joined Server',value: gm?.joinedAt ? `<t:${Math.floor(gm.joinedAt / 1000)}:D>` : 'Not in server', inline: true },
      { name: '🎭 Tier Roles',   value: tierRoles.join(', ') || 'None',                    inline: false },
      { name: '⚠️ Warnings',     value: warns.length ? warns.map((w, n) => `${n + 1}. ${w.reason}`).join('\n') : 'None', inline: false },
      { name: '🔔 Boosting',     value: gm?.premiumSince ? `Since <t:${Math.floor(gm.premiumSince / 1000)}:D>` : 'No', inline: true },
      { name: '📊 All Roles',    value: allRoles.slice(0, 15).join(', ') || 'None',        inline: false },
    )
    .setTimestamp();

  return i.editReply({ embeds: [embed] });
}

// ═════════════════════════════════════════════════════════════════════════════
//  AUTOMOD SETUP
// ═════════════════════════════════════════════════════════════════════════════

async function setupAutoMod(guild) {
  const existing = await guild.autoModerationRules.fetch().catch(() => null);
  if (!existing) return;

  const existingNames = new Set(existing.map(r => r.name));
  const modCh = guild.channels.cache.find(c => c.name === 'mod-actions' && c.type === ChannelType.GuildText);

  const rules = [
    {
      name: 'Aurevon — Mention Spam Guard',
      eventType:   AutoModerationRuleEventType.MessageSend,
      triggerType: AutoModerationRuleTriggerType.MentionSpam,
      triggerMetadata: { mentionTotalLimit: 5 },
      actions: [
        { type: AutoModerationActionType.BlockMessage, metadata: { customMessage: 'Too many mentions. Please keep discussions focused.' } },
        ...(modCh ? [{ type: AutoModerationActionType.SendAlertMessage, metadata: { channel: modCh.id } }] : []),
      ],
      enabled: true,
    },
    {
      name: 'Aurevon — Anti-Spam',
      eventType:   AutoModerationRuleEventType.MessageSend,
      triggerType: AutoModerationRuleTriggerType.Spam,
      actions: [{ type: AutoModerationActionType.BlockMessage }],
      enabled: true,
    },
    {
      name: 'Aurevon — Scam Keyword Filter',
      eventType:   AutoModerationRuleEventType.MessageSend,
      triggerType: AutoModerationRuleTriggerType.Keyword,
      triggerMetadata: {
        keywordFilter: [
          '*guaranteed returns*', '*risk-free investment*', '*100% profit*',
          '*send crypto*', '*dm me for deal*', '*pump and dump*', '*rug pull*',
          '*ponzi*', '*multi-level*', '*get rich quick*', '*wire transfer*',
          '*click this link*', '*free money*', '*double your*',
        ],
      },
      actions: [
        { type: AutoModerationActionType.BlockMessage, metadata: { customMessage: 'This content violates Aurevon community standards.' } },
        ...(modCh ? [{ type: AutoModerationActionType.SendAlertMessage, metadata: { channel: modCh.id } }] : []),
      ],
      enabled: true,
    },
  ];

  for (const rule of rules) {
    if (existingNames.has(rule.name)) continue;
    await guild.autoModerationRules.create(rule)
      .then(() => console.log(`[Bot] ✅  AutoMod: ${rule.name}`))
      .catch(err => console.warn(`[Bot] AutoMod "${rule.name}" skipped: ${err.message}`));
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  GATEWAY EVENTS
// ═════════════════════════════════════════════════════════════════════════════

client.once(Events.ClientReady, async () => {
  console.log(`\n⬛  Aurevon Bot online — ${client.user.tag}`);
  console.log(`    Guild:  ${GUILD_ID}`);
  console.log(`    Site:   ${SITE_URL}\n`);

  client.user.setPresence({
    activities: [{ name: 'Aurevon Operators | /stats', type: ActivityType.Watching }],
    status: 'online',
  });

  await registerCommands().catch(e => console.error('[Bot] Command reg failed:', e.message));

  const guild = client.guilds.cache.get(GUILD_ID) ?? await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (guild) {
    await setupAutoMod(guild);
    await log(guild, 'bot-commands', {
      embeds: [goldEmbed('🟢  Aurevon Bot Online')
        .setDescription(`Ready in **${guild.name}**. ${COMMANDS.length} commands registered.`)
        .addFields({ name: 'Airtable', value: AT_PAT ? '✅ Connected' : '⚠️ Not configured', inline: true })],
    });
  }
});

// ── Member join ───────────────────────────────────────────────────────────────

client.on(Events.GuildMemberAdd, async (member) => {
  if (member.guild.id !== GUILD_ID) return;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Member Portal').setStyle(ButtonStyle.Link).setURL(`${SITE_URL}/member-claim.html`).setEmoji('🔑'),
    new ButtonBuilder().setLabel('Visit Aurevon').setStyle(ButtonStyle.Link).setURL(SITE_URL).setEmoji('🌐'),
  );
  member.send({ embeds: [buildWelcomeDm()], components: [row] }).catch(() => {});
  await log(member.guild, 'join-logs', { embeds: [buildJoinEmbed(member)] });
});

// ── Member leave ──────────────────────────────────────────────────────────────

client.on(Events.GuildMemberRemove, async (member) => {
  if (member.guild.id !== GUILD_ID) return;
  await log(member.guild, 'join-logs', { embeds: [buildLeaveEmbed(member)] });
});

// ── Member update (roles / boost) ─────────────────────────────────────────────

client.on(Events.GuildMemberUpdate, async (oldM, newM) => {
  if (newM.guild.id !== GUILD_ID) return;

  const wasBoosting = oldM.premiumSince !== null;
  const nowBoosting = newM.premiumSince !== null;
  if (!wasBoosting && nowBoosting) {
    const embed = new EmbedBuilder().setColor(0xFF73FA).setTitle('🚀  New Server Boost!')
      .setDescription(`Thank you <@${newM.id}> for boosting **Aurevon Ventures**! 🎉`)
      .addFields({ name: 'Server is now at', value: `Level ${newM.guild.premiumTier} — ${newM.guild.premiumSubscriptionCount} boosts`, inline: false })
      .setTimestamp();
    await log(newM.guild, 'announcements', { embeds: [embed] });
    await log(newM.guild, 'role-logs',     { embeds: [embed] });
  }

  const tierIds = getTierRoleIds();
  const added   = newM.roles.cache.filter(r => !oldM.roles.cache.has(r.id) && tierIds.includes(r.id));
  const removed = oldM.roles.cache.filter(r => !newM.roles.cache.has(r.id) && tierIds.includes(r.id));
  if (added.size || removed.size) {
    const embed = new EmbedBuilder().setColor(GOLD).setTitle('🔄  Tier Role Change')
      .addFields({ name: 'Member', value: `<@${newM.id}> (${newM.user.tag})`, inline: false });
    if (added.size)   embed.addFields({ name: '✅ Added',   value: [...added.values()].map(r => r.name).join(', '),   inline: true });
    if (removed.size) embed.addFields({ name: '❌ Removed', value: [...removed.values()].map(r => r.name).join(', '), inline: true });
    embed.setFooter({ text: `ID: ${newM.id}` }).setTimestamp();
    await log(newM.guild, 'role-logs', { embeds: [embed] });
  }
});

// ── Scheduled event: created ──────────────────────────────────────────────────

client.on(Events.GuildScheduledEventCreate, async (event) => {
  if (event.guildId !== GUILD_ID) return;
  const guild = event.guild ?? client.guilds.cache.get(GUILD_ID);
  if (!guild) return;

  const embed = goldEmbed(`📅  New Event: ${event.name}`)
    .setDescription(event.description ?? 'A new Aurevon Operators event has been scheduled.')
    .addFields({ name: '🕐 Starts', value: `<t:${Math.floor(event.scheduledStartTimestamp / 1000)}:F>`, inline: true });

  await log(guild, 'announcements', { embeds: [embed] });
});

// ── Scheduled event: goes live ────────────────────────────────────────────────

client.on(Events.GuildScheduledEventUpdate, async (oldEvent, newEvent) => {
  if (newEvent.guildId !== GUILD_ID) return;
  if (newEvent.status !== GuildScheduledEventStatus.Active || oldEvent?.status === GuildScheduledEventStatus.Active) return;
  const guild = newEvent.guild ?? client.guilds.cache.get(GUILD_ID);
  if (!guild) return;

  const embed = goldEmbed(`🔴  LIVE NOW: ${newEvent.name}`)
    .setDescription(newEvent.description ?? 'Join us in the voice channel!')
    .addFields({ name: '🎙️ Channel', value: newEvent.channel?.name ?? 'Voice', inline: true });

  await log(guild, 'announcements', { embeds: [embed] });
});

// ── Discord premium entitlement ───────────────────────────────────────────────

client.on(Events.EntitlementCreate, async (entitlement) => {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;

  const user = await client.users.fetch(entitlement.userId).catch(() => null);

  if (user) {
    user.send({ embeds: [goldEmbed('🎉  Welcome to Aurevon Premium!')
      .setDescription('Your Discord subscription is active. Visit the member portal to link your membership and unlock tier channels.')
      .addFields({ name: '🔑 Portal', value: `[Open here →](${SITE_URL}/member-claim.html)`, inline: false })],
    }).catch(() => {});
  }

  await log(guild, 'announcements', {
    embeds: [goldEmbed('💎  New Premium Subscriber')
      .setDescription(user ? `<@${user.id}> just subscribed to Aurevon premium!` : `User \`${entitlement.userId}\` subscribed.`)],
  });
});

// ── Interaction (slash commands + buttons) ────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {

  // ── Button: open ticket ─────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === 'ticket_open') {
    await interaction.deferReply({ ephemeral: true });
    const { guild, user } = interaction;

    const existing = guild.channels.cache.find(c => c.name === `ticket-${user.id}`);
    if (existing) return interaction.editReply(`❌  You already have an open ticket: <#${existing.id}>.`);

    const cat = guild.channels.cache.find(c => c.name.toLowerCase().includes('support') && c.type === ChannelType.GuildCategory);
    const ticketCh = await guild.channels.create({
      name: `ticket-${user.id}`,
      type: ChannelType.GuildText,
      parent: cat?.id,
      permissionOverwrites: [
        { id: guild.id,   deny:  [PermissionFlagsBits.ViewChannel] },
        { id: user.id,    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      ],
    });

    openTickets.set(ticketCh.id, { userId: user.id, createdAt: Date.now() });

    const closeRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket_open').setLabel('🔒 Close Ticket').setStyle(ButtonStyle.Danger).setDisabled(true),
    );

    await ticketCh.send({
      content: `<@${user.id}> — A moderator will be with you shortly.`,
      embeds: [goldEmbed('🎫  Support Ticket Opened')
        .setDescription('Please describe your issue in detail and a team member will respond.\n\nTo close this ticket, a moderator can use `/close-ticket`.')],
      components: [closeRow],
    });

    await log(guild, 'mod-actions', { embeds: [goldEmbed('🎫  Ticket Opened').addFields(
      { name: 'User',    value: `<@${user.id}>`,      inline: true },
      { name: 'Channel', value: `<#${ticketCh.id}>`, inline: true },
    )] });

    return interaction.editReply(`✅  Your ticket has been opened: <#${ticketCh.id}>.`);
  }

  // ── Slash commands ────────────────────────────────────────────────────────
  if (!interaction.isChatInputCommand()) return;

  const CMD_MAP = {
    'warn':           cmdWarn,
    'warnings':       cmdWarnings,
    'clearwarnings':  cmdClearWarnings,
    'timeout':        cmdTimeout,
    'kick':           cmdKick,
    'ban':            cmdBan,
    'unban':          cmdUnban,
    'purge':          cmdPurge,
    'slowmode':       cmdSlowmode,
    'lock':           cmdLock,
    'unlock':         cmdUnlock,
    'modnote':        cmdModnote,
    'announce':       cmdAnnounce,
    'dm-tier':        cmdDmTier,
    'promo':          cmdPromo,
    'poll':           cmdPoll,
    'sync-member':    cmdSyncMember,
    'revoke-member':  cmdRevokeMember,
    'sync-all':       cmdSyncAll,
    'verify-member':  cmdVerifyMember,
    'welcome-dm':     cmdWelcomeDm,
    'add-role':       cmdAddRole,
    'remove-role':    cmdRemoveRole,
    'role-info':      cmdRoleInfo,
    'create-role':    cmdCreateRole,
    'setup-server':   cmdSetupServer,
    'create-channel': cmdCreateChannel,
    'server-info':    cmdServerInfo,
    'set-topic':      cmdSetTopic,
    'ticket-setup':   cmdTicketSetup,
    'close-ticket':   cmdCloseTicket,
    'stats':          cmdStats,
    'boost-stats':    cmdBoostStats,
    'lookup':         cmdLookup,
    'member-report':  cmdMemberReport,
  };

  if (interaction.commandName === 'event') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'create') return cmdEventCreate(interaction).catch(onCmdErr(interaction));
    if (sub === 'list')   return cmdEventList(interaction).catch(onCmdErr(interaction));
    return interaction.reply({ content: '❌  Unknown subcommand.', ephemeral: true });
  }

  const handler = CMD_MAP[interaction.commandName];
  if (!handler) return interaction.reply({ content: '❌  Unknown command.', ephemeral: true });

  handler(interaction).catch(onCmdErr(interaction));
});

function onCmdErr(interaction) {
  return async (err) => {
    console.error(`[Bot] /${interaction.commandName} error:`, err.message);
    const msg = { content: `❌  Error: ${err.message}`, ephemeral: true };
    await (interaction.deferred || interaction.replied
      ? interaction.editReply(msg)
      : interaction.reply(msg)
    ).catch(() => {});
  };
}

// ── Process health ────────────────────────────────────────────────────────────

process.on('unhandledRejection', err => console.error('[Bot] Unhandled rejection:', err));
process.on('SIGINT', () => { client.destroy(); process.exit(0); });

// ── Connect ───────────────────────────────────────────────────────────────────

console.log('[Bot] Connecting...');
client.login(TOKEN).catch(err => {
  console.error('[Bot] Login failed:', err.message);
  process.exit(1);
});
