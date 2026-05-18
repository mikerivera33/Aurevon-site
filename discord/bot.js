/**
 * Aurevon Discord Gateway Bot
 *
 * Guild: Aurevon Ventures (1499526813490221207)
 * App:   1505819653602148372
 *
 * Features:
 *  • 9 admin slash commands (sync, revoke, stats, lookup, announce, welcome-dm,
 *    event, sync-all, boost-stats)
 *  • Full event pipeline: join/leave logs, role-change logs, boost detection,
 *    scheduled-event announcements, Discord premium entitlements
 *  • AutoMod setup on first boot (keyword + mention-spam rules)
 *  • All Discord monetization hooks wired in
 *  • Imports shared entitlements + Airtable libs from ../api/_lib/
 *
 * Run:  node bot.js   (requires .env — see .env.example)
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
  AutoModerationRuleEventType,
  AutoModerationRuleTriggerType,
  AutoModerationActionType,
} from 'discord.js';

import {
  ENTITLEMENT_MAP,
  resolveEntitlementFromNftType,
  getRoleId,
} from '../api/_lib/entitlements.js';

import {
  findMemberByEmail,
  findActiveMintByEmail,
  updateDiscordSyncStatus,
  listPendingDiscordSync,
} from '../api/_lib/airtable.js';

// ── Env validation ────────────────────────────────────────────────────────────

const TOKEN    = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID ?? '1499526813490221207';
const SITE_URL = process.env.SITE_URL          ?? 'https://www.aurevonvc.com';

if (!TOKEN) {
  console.error('[Bot] ❌  Missing DISCORD_BOT_TOKEN — copy .env.example to .env and fill in.');
  process.exit(1);
}

// ── Client ────────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,          // Privileged — enable in Dev Portal
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,        // Privileged — enable in Dev Portal
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildScheduledEvents,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildPresences,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

// ── Constants ─────────────────────────────────────────────────────────────────

const BRAND_GOLD  = 0xC8A96E;
const BRAND_DARK  = 0x1A1A2E;
const BRAND_RED   = 0xC0542C;
const BRAND_GREEN = 0x2A7A4F;
const TIER_ORDER  = ['verified', 'insider', 'ember', 'obsidian', 'chrome', 'genesis'];

// Spam/promo keywords to block in AutoMod
const BLOCKED_KEYWORDS = [
  'pump and dump', 'guaranteed returns', 'get rich quick', 'wire me',
  'send crypto', 'dm for investment', '100x returns', 'rug pull',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Find a text channel by name; returns null if missing */
function findChannel(guild, name) {
  return guild.channels.cache.find(
    c => c.name === name && c.type === ChannelType.GuildText,
  ) ?? null;
}

/** Find a voice channel by name */
function findVoiceChannel(guild, name) {
  return guild.channels.cache.find(
    c => c.name === name && c.type === ChannelType.GuildVoice,
  ) ?? null;
}

/** All active tier role IDs from env (excludes nulls) */
function getTierRoleIds() {
  return Object.values(ENTITLEMENT_MAP)
    .map(cfg => process.env[cfg.discordRoleEnv])
    .filter(Boolean);
}

/** Post an embed to a named channel; silent on failure */
async function sendLog(guild, channelName, embed) {
  try {
    const ch = findChannel(guild, channelName);
    if (ch) await ch.send({ embeds: [embed] });
  } catch { /* non-fatal */ }
}

/** Base Aurevon-branded embed */
function goldEmbed(title) {
  return new EmbedBuilder()
    .setColor(BRAND_GOLD)
    .setTitle(title)
    .setFooter({ text: 'Aurevon Ventures LLC' })
    .setTimestamp();
}

/** Tier role display name lookup */
function tierLabel(roleId) {
  for (const [, cfg] of Object.entries(ENTITLEMENT_MAP)) {
    if (process.env[cfg.discordRoleEnv] === roleId) return cfg.nftType;
  }
  if (roleId === process.env.DISCORD_ROLE_VERIFIED) return 'Verified Member';
  return 'Unknown Role';
}

// ── Embed builders ────────────────────────────────────────────────────────────

function buildWelcomeDm() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Verify Membership')
      .setStyle(ButtonStyle.Link)
      .setURL(`${SITE_URL}/member-claim.html`)
      .setEmoji('🔑'),
    new ButtonBuilder()
      .setLabel('Visit Aurevon')
      .setStyle(ButtonStyle.Link)
      .setURL(SITE_URL)
      .setEmoji('🌐'),
  );

  const embed = new EmbedBuilder()
    .setColor(BRAND_GOLD)
    .setTitle('Welcome to Aurevon Ventures ⬛')
    .setDescription(
      'You have joined an exclusive network of real estate operators and investors.\n\n' +
      '**To unlock your tier channels:**\n' +
      '1. Click **Verify Membership** below\n' +
      '2. Sign in with your purchase email\n' +
      '3. Click **Connect Discord**\n' +
      '4. Your role is assigned instantly\n\n' +
      '_If you are not yet a member, visit the site to explore membership options._',
    )
    .addFields(
      { name: '🟡 001 Genesis',                  value: 'Monthly membership — full access', inline: true },
      { name: '⬜ 004 Chrome',                    value: 'Lifetime membership',              inline: true },
      { name: '🟣 Aurevon Obsidian Executive',    value: 'Advanced deal flow + lounges',     inline: true },
      { name: '🟠 Aurevon Ember',                 value: 'Core deal flow + lounges',         inline: true },
      { name: '🟢 Aurevon Insider',               value: 'Market intel + Insider Lounge',    inline: true },
    )
    .setFooter({ text: 'Questions? support@aurevongroup.com' });

  return { embeds: [embed], components: [row] };
}

function buildJoinEmbed(member) {
  const created = Math.floor(member.user.createdTimestamp / 1000);
  const memberCount = member.guild.memberCount;
  return new EmbedBuilder()
    .setColor(BRAND_GREEN)
    .setTitle('👋  New Member Joined')
    .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
    .addFields(
      { name: 'User',         value: `<@${member.id}> \`${member.user.tag}\``, inline: false },
      { name: 'Account Age',  value: `<t:${created}:R>`,                       inline: true  },
      { name: 'Member #',     value: String(memberCount),                       inline: true  },
    )
    .setFooter({ text: `ID: ${member.id}` })
    .setTimestamp();
}

function buildLeaveEmbed(member) {
  const roles = [...member.roles.cache.values()]
    .filter(r => r.id !== member.guild.id)
    .map(r => r.name)
    .join(', ') || 'None';

  return new EmbedBuilder()
    .setColor(BRAND_RED)
    .setTitle('🚪  Member Left')
    .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
    .addFields(
      { name: 'User',   value: `${member.user.tag} \`${member.id}\``, inline: false },
      { name: 'Roles',  value: roles,                                  inline: false },
    )
    .setFooter({ text: `ID: ${member.id}` })
    .setTimestamp();
}

function buildRoleChangeEmbed(member, added, removed) {
  const embed = new EmbedBuilder()
    .setColor(BRAND_GOLD)
    .setTitle('🔄  Role Update')
    .addFields({ name: 'Member', value: `<@${member.id}> \`${member.user.tag}\``, inline: false });

  if (added.size > 0) {
    embed.addFields({
      name:   '✅  Roles Added',
      value:  [...added.values()].map(r => `<@&${r.id}>`).join(' '),
      inline: false,
    });
  }
  if (removed.size > 0) {
    embed.addFields({
      name:   '❌  Roles Removed',
      value:  [...removed.values()].map(r => `<@&${r.id}>`).join(' '),
      inline: false,
    });
  }

  return embed.setFooter({ text: `ID: ${member.id}` }).setTimestamp();
}

function buildBoostEmbed(member, isNewBoost) {
  const level = member.guild.premiumTier;
  const count = member.guild.premiumSubscriptionCount ?? 0;
  const needed = [2, 7, 14];
  const next = needed.find(n => n > count) ?? '✓ Max';

  return new EmbedBuilder()
    .setColor(0xFF73FA)
    .setTitle(isNewBoost ? '🚀  New Server Boost!' : '💨  Boost Removed')
    .setDescription(
      isNewBoost
        ? `**${member.user.username}** just boosted Aurevon Ventures! 🎉`
        : `**${member.user.username}** removed their boost.`,
    )
    .addFields(
      { name: 'Boost Level', value: `Level ${level}`,    inline: true },
      { name: 'Total Boosts', value: String(count),      inline: true },
      { name: 'Next Level',  value: `${next} boosts`,    inline: true },
    )
    .setFooter({ text: 'Aurevon Ventures LLC' })
    .setTimestamp();
}

function buildEventEmbed(event, status = 'created') {
  const start = Math.floor(event.scheduledStartTimestamp / 1000);
  const action = status === 'started' ? '🟢  Event Started' : '📅  Event Scheduled';

  return new EmbedBuilder()
    .setColor(BRAND_GOLD)
    .setTitle(action)
    .setDescription(`**${event.name}**\n\n${event.description ?? ''}`)
    .addFields(
      { name: 'Start',      value: `<t:${start}:F>`, inline: true },
      { name: 'Interested', value: String(event.userCount ?? 0), inline: true },
    )
    .setFooter({ text: 'Aurevon Ventures LLC' })
    .setTimestamp();
}

function buildStatsEmbed(counts, guild) {
  const embed = goldEmbed('⬛  Aurevon Operators — Server Stats')
    .addFields(
      { name: 'Total Members', value: String(guild.memberCount), inline: true },
      { name: 'Boost Level',   value: String(guild.premiumTier), inline: true },
      { name: 'Boosts',        value: String(guild.premiumSubscriptionCount ?? 0), inline: true },
      { name: '​',        value: '​', inline: false },
    );

  for (const [nftType, count] of Object.entries(counts)) {
    embed.addFields({ name: nftType, value: String(count), inline: true });
  }

  return embed;
}

// ── Slash command definitions ─────────────────────────────────────────────────

const COMMANDS = [
  new SlashCommandBuilder()
    .setName('sync-member')
    .setDescription('Assign the correct Aurevon tier role to a member via their email')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o =>
      o.setName('email').setDescription("Member's email address (used at purchase)").setRequired(true)),

  new SlashCommandBuilder()
    .setName('revoke-member')
    .setDescription('Strip all Aurevon tier roles from a Discord member')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o =>
      o.setName('user').setDescription('Discord member to revoke').setRequired(true)),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show live Aurevon member counts by tier')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('lookup')
    .setDescription('Look up an Aurevon member profile from Airtable')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o =>
      o.setName('email').setDescription("Member's email").setRequired(false))
    .addUserOption(o =>
      o.setName('user').setDescription('Discord user (only shows Discord info)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Post a branded announcement to #announcements')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o =>
      o.setName('message').setDescription('Announcement body text').setRequired(true))
    .addStringOption(o =>
      o.setName('title').setDescription('Embed title (optional)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('welcome-dm')
    .setDescription('Re-send the Aurevon welcome + verify DM to a member')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o =>
      o.setName('user').setDescription('Discord member').setRequired(true)),

  new SlashCommandBuilder()
    .setName('event')
    .setDescription('Manage Aurevon scheduled events')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('create')
        .setDescription('Create a new scheduled event')
        .addStringOption(o =>
          o.setName('title').setDescription('Event title').setRequired(true))
        .addStringOption(o =>
          o.setName('description').setDescription('Event description').setRequired(true))
        .addStringOption(o =>
          o.setName('start').setDescription('Start time — ISO or "YYYY-MM-DD HH:MM UTC"').setRequired(true))
        .addStringOption(o =>
          o.setName('venue')
            .setDescription('Venue (defaults to Deal Room)')
            .setRequired(false)
            .addChoices(
              { name: 'Deal Room (Voice)',        value: 'Deal Room'        },
              { name: 'Operator Suite (Voice)',   value: 'Operator Suite'   },
              { name: 'Genesis War Room (Voice)', value: 'Genesis War Room' },
            ))),

  new SlashCommandBuilder()
    .setName('sync-all')
    .setDescription('Batch-sync all pending Discord role assignments from Airtable')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('boost-stats')
    .setDescription('Show server boost level, count, and current boosters')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

].map(c => c.toJSON());

// ── Command registration ───────────────────────────────────────────────────────

async function registerCommands(clientId) {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(clientId, GUILD_ID), { body: COMMANDS });
    console.log(`[Bot] ✅  Registered ${COMMANDS.length} slash commands (guild-scoped — instant)`);
  } catch (err) {
    console.error('[Bot] ❌  Command registration failed:', err.message);
  }
}

// ── Command handlers ──────────────────────────────────────────────────────────

async function handleSyncMember(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const email = interaction.options.getString('email').toLowerCase().trim();

  let mint;
  try { mint = await findActiveMintByEmail(email); }
  catch (e) { return interaction.editReply(`❌ Airtable error: ${e.message}`); }

  if (!mint) return interaction.editReply(`❌ No active NFT mint found for **${email}**`);

  const nftType = mint.fields['NFT Type'] ?? '';
  const entKey  = resolveEntitlementFromNftType(nftType);
  const roleId  = entKey ? getRoleId(entKey) : null;

  if (!roleId) return interaction.editReply(`❌ No Discord role configured for NFT type: \`${nftType}\``);

  let memberRecord;
  try { memberRecord = await findMemberByEmail(email); }
  catch (e) { return interaction.editReply(`❌ Member lookup failed: ${e.message}`); }

  const discordId = memberRecord?.fields?.['Discord ID'];
  if (!discordId) {
    return interaction.editReply(
      `⚠️ No Discord ID linked for **${email}**.\nMember must complete OAuth at: ${SITE_URL}/member-claim.html`,
    );
  }

  let guildMember;
  try { guildMember = await interaction.guild.members.fetch(discordId); }
  catch { return interaction.editReply(`❌ Discord user \`${discordId}\` is not in this server.`); }

  try {
    await guildMember.roles.add(roleId);
    await updateDiscordSyncStatus(email, 'synced');
  } catch (e) {
    return interaction.editReply(`❌ Role assignment failed: ${e.message}`);
  }

  const embed = goldEmbed('✅  Member Synced')
    .addFields(
      { name: 'User',  value: `<@${discordId}>`,             inline: true },
      { name: 'Email', value: email,                          inline: true },
      { name: 'Role',  value: `<@&${roleId}> (${nftType})`,  inline: false },
    );

  await sendLog(interaction.guild, 'role-logs', embed);
  return interaction.editReply({ embeds: [embed] });
}

async function handleRevokeMember(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const target = interaction.options.getUser('user');

  let guildMember;
  try { guildMember = await interaction.guild.members.fetch(target.id); }
  catch { return interaction.editReply(`❌ <@${target.id}> is not in this server.`); }

  const allTierIds = [
    ...getTierRoleIds(),
    process.env.DISCORD_ROLE_VERIFIED,
  ].filter(Boolean);

  const toRemove = guildMember.roles.cache.filter(r => allTierIds.includes(r.id));

  if (toRemove.size === 0) {
    return interaction.editReply(`⚠️ <@${target.id}> has no Aurevon tier roles to remove.`);
  }

  try { await guildMember.roles.remove([...toRemove.keys()]); }
  catch (e) { return interaction.editReply(`❌ Role removal failed: ${e.message}`); }

  const embed = new EmbedBuilder()
    .setColor(BRAND_RED)
    .setTitle('🚫  Member Revoked')
    .addFields(
      { name: 'User',          value: `<@${target.id}> \`${target.tag}\``, inline: false },
      { name: 'Roles Removed', value: [...toRemove.values()].map(r => r.name).join(', '), inline: false },
    )
    .setFooter({ text: 'Aurevon Ventures LLC' })
    .setTimestamp();

  await sendLog(interaction.guild, 'role-logs', embed);
  return interaction.editReply({ embeds: [embed] });
}

async function handleStats(interaction) {
  await interaction.deferReply({ ephemeral: true });

  let members;
  try { members = await interaction.guild.members.fetch(); }
  catch (e) { return interaction.editReply(`❌ Could not fetch members: ${e.message}`); }

  const counts = {};
  for (const [, cfg] of Object.entries(ENTITLEMENT_MAP)) {
    const rid = process.env[cfg.discordRoleEnv];
    if (rid) counts[cfg.nftType] = members.filter(m => m.roles.cache.has(rid)).size;
  }

  const verifiedId = process.env.DISCORD_ROLE_VERIFIED;
  if (verifiedId) {
    const tieredIds = new Set(getTierRoleIds());
    counts['Verified (no tier)'] = members.filter(
      m => m.roles.cache.has(verifiedId) && !getTierRoleIds().some(rid => m.roles.cache.has(rid)),
    ).size;
  }

  return interaction.editReply({ embeds: [buildStatsEmbed(counts, interaction.guild)] });
}

async function handleLookup(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const email      = interaction.options.getString('email');
  const targetUser = interaction.options.getUser('user');

  if (!email && !targetUser) {
    return interaction.editReply('❌ Provide either an `email` or a `user`.');
  }

  // Discord-side lookup
  if (targetUser && !email) {
    let gm;
    try { gm = await interaction.guild.members.fetch(targetUser.id); }
    catch { return interaction.editReply(`❌ <@${targetUser.id}> not found in server.`); }

    const tierRoles = gm.roles.cache.filter(r => getTierRoleIds().includes(r.id));
    const embed = goldEmbed(`🔍  ${targetUser.username}`)
      .setThumbnail(targetUser.displayAvatarURL({ size: 128 }))
      .addFields(
        { name: 'Discord ID',  value: targetUser.id,         inline: true },
        { name: 'Joined',      value: `<t:${Math.floor(gm.joinedTimestamp / 1000)}:R>`, inline: true },
        { name: 'Tier Roles',  value: tierRoles.size > 0 ? [...tierRoles.values()].map(r => r.name).join(', ') : 'None', inline: false },
      );

    return interaction.editReply({ embeds: [embed] });
  }

  // Airtable lookup by email
  const lookupEmail = email.toLowerCase().trim();
  let member, mint;
  try {
    [member, mint] = await Promise.all([
      findMemberByEmail(lookupEmail),
      findActiveMintByEmail(lookupEmail),
    ]);
  } catch (e) {
    return interaction.editReply(`❌ Airtable error: ${e.message}`);
  }

  if (!member) return interaction.editReply(`❌ No member found for **${lookupEmail}**`);

  const f = member.fields;
  const mf = mint?.fields ?? {};

  const embed = goldEmbed(`🔍  ${f['Name'] ?? lookupEmail}`)
    .addFields(
      { name: 'Email',        value: lookupEmail,                    inline: true  },
      { name: 'Discord ID',   value: f['Discord ID'] ?? '—',        inline: true  },
      { name: 'Sync Status',  value: f['Discord Sync Status'] ?? '—', inline: true },
      { name: 'NFT Type',     value: mf['NFT Type'] ?? '—',         inline: true  },
      { name: 'Reference',    value: mf['Reference'] ?? '—',        inline: true  },
      { name: 'Mint Status',  value: mf['Status'] ?? '—',           inline: true  },
    );

  return interaction.editReply({ embeds: [embed] });
}

async function handleAnnounce(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const message = interaction.options.getString('message');
  const title   = interaction.options.getString('title') ?? '📢  Aurevon Announcement';

  const ch = findChannel(interaction.guild, 'announcements');
  if (!ch) return interaction.editReply('❌ #announcements channel not found. Run `discord/setup.js` first.');

  const embed = goldEmbed(title).setDescription(message);

  try { await ch.send({ embeds: [embed] }); }
  catch (e) { return interaction.editReply(`❌ Failed to post: ${e.message}`); }

  return interaction.editReply(`✅ Announcement posted to <#${ch.id}>`);
}

async function handleWelcomeDm(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const target = interaction.options.getUser('user');

  try {
    await target.send(buildWelcomeDm());
    return interaction.editReply(`✅ Welcome DM sent to <@${target.id}>`);
  } catch {
    return interaction.editReply(`⚠️ Could not DM <@${target.id}> — they may have DMs disabled.`);
  }
}

async function handleEventCreate(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const title   = interaction.options.getString('title');
  const desc    = interaction.options.getString('description');
  const startRaw = interaction.options.getString('start');
  const venueName = interaction.options.getString('venue') ?? 'Deal Room';

  const startDate = new Date(startRaw);
  if (isNaN(startDate.getTime())) {
    return interaction.editReply('❌ Invalid start time. Use ISO format: `2025-06-15T18:00:00Z` or `2025-06-15 18:00 UTC`');
  }
  if (startDate < new Date()) {
    return interaction.editReply('❌ Start time must be in the future.');
  }

  const voiceChannel = findVoiceChannel(interaction.guild, venueName);
  if (!voiceChannel) {
    return interaction.editReply(`❌ Voice channel "${venueName}" not found. Run setup.js first.`);
  }

  let event;
  try {
    event = await interaction.guild.scheduledEvents.create({
      name: title,
      description: desc,
      scheduledStartTime: startDate,
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityType: GuildScheduledEventEntityType.Voice,
      channel: voiceChannel.id,
    });
  } catch (e) {
    return interaction.editReply(`❌ Event creation failed: ${e.message}`);
  }

  // Announce in #announcements
  const announceCh = findChannel(interaction.guild, 'announcements');
  if (announceCh) {
    const start = Math.floor(startDate.getTime() / 1000);
    await announceCh.send({
      embeds: [
        goldEmbed(`📅  Event Scheduled — ${title}`)
          .setDescription(desc)
          .addFields(
            { name: 'Start',  value: `<t:${start}:F>`,    inline: true  },
            { name: 'Venue',  value: venueName,            inline: true  },
            { name: 'RSVP',   value: `[Set Reminder](https://discord.com/events/${GUILD_ID}/${event.id})`, inline: true },
          ),
      ],
    });
  }

  return interaction.editReply(`✅ Event **${title}** created — starts <t:${Math.floor(startDate.getTime() / 1000)}:R>`);
}

async function handleSyncAll(interaction) {
  await interaction.deferReply({ ephemeral: true });

  let pending;
  try { pending = await listPendingDiscordSync({ maxRecords: 100 }); }
  catch (e) { return interaction.editReply(`❌ Airtable error: ${e.message}`); }

  if (!pending.length) return interaction.editReply('✅ No pending sync members found.');

  let synced = 0;
  let failed = 0;
  const errors = [];

  for (const record of pending) {
    const email     = record.fields?.['Email'] ?? '';
    const discordId = record.fields?.['Discord ID'];
    if (!email || !discordId) continue;

    try {
      const mint = await findActiveMintByEmail(email);
      if (!mint) continue;

      const nftType = mint.fields['NFT Type'] ?? '';
      const entKey  = resolveEntitlementFromNftType(nftType);
      const roleId  = entKey ? getRoleId(entKey) : null;
      if (!roleId) continue;

      const gm = await interaction.guild.members.fetch(discordId).catch(() => null);
      if (!gm) continue;

      await gm.roles.add(roleId);
      await updateDiscordSyncStatus(email, 'synced');
      synced++;
    } catch (e) {
      failed++;
      errors.push(`${email}: ${e.message}`);
      await updateDiscordSyncStatus(email, 'failed', { error: e.message }).catch(() => {});
    }
  }

  const embed = goldEmbed('🔄  Sync-All Complete')
    .addFields(
      { name: 'Pending',  value: String(pending.length), inline: true },
      { name: '✅ Synced', value: String(synced),         inline: true },
      { name: '❌ Failed', value: String(failed),         inline: true },
    );

  if (errors.length) {
    embed.addFields({ name: 'Errors', value: errors.slice(0, 5).join('\n'), inline: false });
  }

  return interaction.editReply({ embeds: [embed] });
}

async function handleBoostStats(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const guild  = interaction.guild;
  const level  = guild.premiumTier;
  const count  = guild.premiumSubscriptionCount ?? 0;
  const needed = [2, 7, 14];
  const nextAt = needed.find(n => n > count);

  let members;
  try { members = await guild.members.fetch(); }
  catch { members = guild.members.cache; }

  const boosters = members.filter(m => !!m.premiumSinceTimestamp);
  const boosterList = [...boosters.values()]
    .map(m => `<@${m.id}>`)
    .slice(0, 15)
    .join(', ') || 'None';

  const embed = new EmbedBuilder()
    .setColor(0xFF73FA)
    .setTitle('🚀  Boost Status — Aurevon Ventures')
    .addFields(
      { name: 'Boost Level',  value: `Level ${level}`,              inline: true  },
      { name: 'Total Boosts', value: String(count),                  inline: true  },
      { name: 'Next Level',   value: nextAt ? `${nextAt} needed` : '✓ Max', inline: true },
      { name: `Boosters (${boosters.size})`, value: boosterList,    inline: false },
    )
    .setFooter({ text: 'Aurevon Ventures LLC' })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

// ── AutoMod setup ─────────────────────────────────────────────────────────────

async function setupAutoMod(guild) {
  try {
    const existing = await guild.autoModerationRules.fetch();
    const names = new Set([...existing.values()].map(r => r.name));

    if (!names.has('Aurevon — Spam Keywords')) {
      await guild.autoModerationRules.create({
        name: 'Aurevon — Spam Keywords',
        eventType: AutoModerationRuleEventType.MessageSend,
        triggerType: AutoModerationRuleTriggerType.Keyword,
        triggerMetadata: { keywordFilter: BLOCKED_KEYWORDS },
        actions: [
          { type: AutoModerationActionType.BlockMessage,   metadata: { customMessage: 'Message blocked by Aurevon moderation.' } },
          { type: AutoModerationActionType.SendAlertMessage, metadata: { channel: findChannel(guild, 'mod-actions')?.id ?? null } },
        ].filter(a => a.metadata.channel !== null || a.type === AutoModerationActionType.BlockMessage),
        enabled: true,
      });
      console.log('[Bot] ✅  AutoMod: keyword filter rule created');
    }

    if (!names.has('Aurevon — Mention Spam')) {
      await guild.autoModerationRules.create({
        name: 'Aurevon — Mention Spam',
        eventType: AutoModerationRuleEventType.MessageSend,
        triggerType: AutoModerationRuleTriggerType.MentionSpam,
        triggerMetadata: { mentionTotalLimit: 5, mentionRaidProtectionEnabled: true },
        actions: [
          { type: AutoModerationActionType.BlockMessage,   metadata: { customMessage: 'Too many mentions.' } },
          { type: AutoModerationActionType.Timeout,        metadata: { durationSeconds: 300 } },
        ],
        enabled: true,
      });
      console.log('[Bot] ✅  AutoMod: mention-spam rule created');
    }
  } catch (e) {
    // AutoMod requires Community mode — warn but don't crash
    console.warn('[Bot] ⚠️  AutoMod setup skipped:', e.message);
  }
}

// ── Event handlers ────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async () => {
  console.log(`[Bot] ✅  Logged in as ${client.user.tag}`);
  console.log(`[Bot]     Guild: ${GUILD_ID} (Aurevon Ventures)`);

  client.user.setPresence({
    activities: [{ name: 'Aurevon Operators · /verify', type: ActivityType.Watching }],
    status: 'online',
  });

  await registerCommands(client.user.id);

  const guild = client.guilds.cache.get(GUILD_ID);
  if (guild) {
    await setupAutoMod(guild);
    const botCh = findChannel(guild, 'bot-commands');
    if (botCh) {
      await botCh.send({
        embeds: [
          goldEmbed('🤖  Aurevon Bot Online')
            .setDescription(`Bot started at <t:${Math.floor(Date.now() / 1000)}:F>\n${COMMANDS.length} slash commands registered.`),
        ],
      }).catch(() => {});
    }
  }
});

client.on(Events.GuildMemberAdd, async member => {
  if (member.guild.id !== GUILD_ID) return;

  // Welcome DM
  member.send(buildWelcomeDm()).catch(() => {});

  // Join log
  await sendLog(member.guild, 'join-logs', buildJoinEmbed(member));
});

client.on(Events.GuildMemberRemove, async member => {
  if (member.guild.id !== GUILD_ID) return;
  await sendLog(member.guild, 'join-logs', buildLeaveEmbed(member));
});

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  if (newMember.guild.id !== GUILD_ID) return;

  const tierIds = new Set(getTierRoleIds());

  // Detect tier role changes
  const added   = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id) && tierIds.has(r.id));
  const removed = oldMember.roles.cache.filter(r => !newMember.roles.cache.has(r.id) && tierIds.has(r.id));

  if (added.size > 0 || removed.size > 0) {
    await sendLog(newMember.guild, 'role-logs', buildRoleChangeEmbed(newMember, added, removed));
  }

  // Boost detection
  const wasBooster = !!oldMember.premiumSinceTimestamp;
  const isBooster  = !!newMember.premiumSinceTimestamp;

  if (!wasBooster && isBooster) {
    // New boost
    const ch = findChannel(newMember.guild, 'announcements');
    if (ch) await ch.send({ embeds: [buildBoostEmbed(newMember, true)] }).catch(() => {});
    await sendLog(newMember.guild, 'role-logs', buildBoostEmbed(newMember, true));
  } else if (wasBooster && !isBooster) {
    // Boost removed
    await sendLog(newMember.guild, 'role-logs', buildBoostEmbed(newMember, false));
  }
});

// Scheduled event created → announce in #announcements
client.on(Events.GuildScheduledEventCreate, async event => {
  if (event.guildId !== GUILD_ID) return;
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;
  await sendLog(guild, 'announcements', buildEventEmbed(event, 'created'));
});

// Scheduled event started
client.on(Events.GuildScheduledEventUpdate, async (oldEvent, newEvent) => {
  if (newEvent.guildId !== GUILD_ID) return;
  if (newEvent.isActive() && !oldEvent.isActive()) {
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return;
    await sendLog(guild, 'announcements', buildEventEmbed(newEvent, 'started'));
  }
});

// Discord premium app entitlement (app subscriptions via Developer Portal SKUs)
client.on(Events.EntitlementCreate, async entitlement => {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;

  const embed = goldEmbed('💎  New Discord Premium Subscription')
    .setDescription(`User <@${entitlement.userId}> activated a Discord premium entitlement.`)
    .addFields({ name: 'SKU ID', value: entitlement.skuId, inline: true })
    .setColor(0xFF73FA);

  await sendLog(guild, 'join-logs', embed);
  await sendLog(guild, 'bot-commands', embed);
});

// Audit log — ban/kick tracking
client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
  if (guild.id !== GUILD_ID) return;

  const { action, executor, target, reason } = entry;
  const WATCHED = ['MemberBanAdd', 'MemberBanRemove', 'MemberKick', 'MemberRoleUpdate'];
  if (!WATCHED.includes(action)) return;

  const embed = new EmbedBuilder()
    .setColor(BRAND_RED)
    .setTitle(`🔨  Audit: ${action}`)
    .addFields(
      { name: 'Executor', value: executor ? `<@${executor.id}>` : '—', inline: true },
      { name: 'Target',   value: target   ? `<@${target.id}>`   : '—', inline: true },
      { name: 'Reason',   value: reason ?? 'No reason provided',        inline: false },
    )
    .setTimestamp();

  await sendLog(guild, 'audit-log',   embed);
  await sendLog(guild, 'mod-actions', embed);
});

// Interaction routing
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.guildId !== GUILD_ID)  return;

  const sub = interaction.options.getSubcommand(false);

  try {
    switch (interaction.commandName) {
      case 'sync-member':  return await handleSyncMember(interaction);
      case 'revoke-member':return await handleRevokeMember(interaction);
      case 'stats':        return await handleStats(interaction);
      case 'lookup':       return await handleLookup(interaction);
      case 'announce':     return await handleAnnounce(interaction);
      case 'welcome-dm':   return await handleWelcomeDm(interaction);
      case 'event':
        if (sub === 'create') return await handleEventCreate(interaction);
        break;
      case 'sync-all':     return await handleSyncAll(interaction);
      case 'boost-stats':  return await handleBoostStats(interaction);
    }
  } catch (err) {
    console.error(`[Bot] Command error (${interaction.commandName}):`, err);
    const msg = `❌ Unexpected error: ${err.message}`;
    if (interaction.deferred) {
      await interaction.editReply(msg).catch(() => {});
    } else {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
});

// Global error handling — keep bot alive
client.on('error', err => console.error('[Bot] Client error:', err.message));
process.on('unhandledRejection', err => console.error('[Bot] Unhandled rejection:', err));
process.on('uncaughtException',  err => { console.error('[Bot] Uncaught exception:', err); process.exit(1); });

// ── Login ─────────────────────────────────────────────────────────────────────

client.login(TOKEN).catch(err => {
  console.error('[Bot] ❌  Login failed:', err.message);
  if (err.message.includes('TOKEN_INVALID')) {
    console.error('    → Check DISCORD_BOT_TOKEN in your .env file.');
  }
  process.exit(1);
});
