/**
 * Aurevon Discord Bot — Full Gateway Bot
 *
 * Guild:  Aurevon Ventures  (1499526813490221207)
 * App ID: 1505819653602148372
 *
 * Features:
 *   • 9 admin slash commands (sync, revoke, stats, lookup, announce,
 *     welcome-dm, event create, sync-all, boost-stats)
 *   • Real-time events: member join/leave, role changes, boost detection,
 *     scheduled event lifecycle, Discord premium entitlements
 *   • AutoMod rules (spam, mention flood, keyword filter)
 *   • Branded embeds throughout (Aurevon gold #C8A96E)
 *   • Full Airtable integration via existing api/_lib
 *   • Maximum Discord monetization coverage
 *
 * Run:  node bot.js
 * Env:  copy .env.example → .env and fill all vars
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
const SITE_URL = process.env.SITE_URL         ?? 'https://www.aurevonvc.com';

if (!TOKEN) {
  console.error('❌  DISCORD_BOT_TOKEN is required. Copy .env.example → .env and fill it in.');
  process.exit(1);
}

// ── Role ID helpers ───────────────────────────────────────────────────────────

/** All five entitlement tier role IDs (excludes verified / booster). */
function getTierRoleIds() {
  return Object.values(ENTITLEMENT_MAP)
    .map(cfg => process.env[cfg.discordRoleEnv])
    .filter(Boolean);
}

/** Every managed role ID (tiers + verified). */
function getAllManagedRoleIds() {
  return [...getTierRoleIds(), process.env.DISCORD_ROLE_VERIFIED].filter(Boolean);
}

// ── Slash command definitions ─────────────────────────────────────────────────

const COMMANDS = [
  new SlashCommandBuilder()
    .setName('sync-member')
    .setDescription('Assign the correct Aurevon tier role from Airtable for a member')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o =>
      o.setName('email').setDescription("Member's purchase email").setRequired(true)),

  new SlashCommandBuilder()
    .setName('revoke-member')
    .setDescription('Strip all Aurevon tier roles from a Discord member')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o =>
      o.setName('user').setDescription('Discord member to revoke').setRequired(true)),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Live Aurevon Operators server stats by tier')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('lookup')
    .setDescription('Look up an Aurevon member profile from Airtable')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o =>
      o.setName('email').setDescription("Member's email address").setRequired(false))
    .addUserOption(o =>
      o.setName('user').setDescription('Discord user').setRequired(false)),

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
    .setDescription('Re-send the Aurevon verification DM to a member')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o =>
      o.setName('user').setDescription('Discord member to DM').setRequired(true)),

  new SlashCommandBuilder()
    .setName('event')
    .setDescription('Manage Aurevon Operators scheduled events')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('create')
        .setDescription('Create a scheduled event in a voice channel')
        .addStringOption(o =>
          o.setName('title').setDescription('Event title').setRequired(true))
        .addStringOption(o =>
          o.setName('description').setDescription('Event description').setRequired(true))
        .addStringOption(o =>
          o.setName('start_time')
            .setDescription('ISO 8601 start time — e.g. 2025-06-01T18:00:00Z')
            .setRequired(true))
        .addStringOption(o =>
          o.setName('channel')
            .setDescription('Voice channel for the event')
            .setRequired(false)
            .addChoices(
              { name: 'General Lounge',   value: 'General Lounge'   },
              { name: 'Deal Room',        value: 'Deal Room'        },
              { name: 'Operator Suite',   value: 'Operator Suite'   },
              { name: 'Genesis War Room', value: 'Genesis War Room' },
            ))),

  new SlashCommandBuilder()
    .setName('sync-all')
    .setDescription('Batch-sync all pending Airtable members to their Discord roles')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('boost-stats')
    .setDescription('Show server boost level, booster count, and unlock progress')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map(c => c.toJSON());

// ── Discord client ────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,          // Privileged
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,        // Privileged
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildScheduledEvents,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

// ── Command registration ──────────────────────────────────────────────────────

async function registerCommands(clientId) {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(clientId, GUILD_ID), { body: COMMANDS });
  console.log(`[Bot] ✅  Registered ${COMMANDS.length} slash commands (guild-scoped — instant)`);
}

// ── Embed helpers ─────────────────────────────────────────────────────────────

const GOLD  = 0xC8A96E;
const RED   = 0xED4245;
const GREEN = 0x57F287;

function goldEmbed(title) {
  return new EmbedBuilder()
    .setColor(GOLD)
    .setTitle(title)
    .setFooter({ text: 'Aurevon Ventures LLC' })
    .setTimestamp();
}

function buildWelcomeDmEmbed() {
  return new EmbedBuilder()
    .setColor(GOLD)
    .setTitle('Welcome to Aurevon Operators ⬛')
    .setDescription(
      'You have been added to an exclusive network of real estate operators and investors.\n\n' +
      '**To unlock your tier channels, verify your membership:**'
    )
    .addFields(
      { name: '1️⃣  Visit the Member Portal', value: `[Click here](${SITE_URL}/member-claim.html) and sign in with your purchase email.`, inline: false },
      { name: '2️⃣  Connect Discord',          value: 'Click the **Connect Discord** button in the portal.',                               inline: false },
      { name: '3️⃣  Authorize',                value: 'Approve the Discord connection — your tier role is assigned automatically.',        inline: false },
    )
    .addFields({ name: '❓  Questions?', value: 'Email **support@aurevongroup.com**', inline: false })
    .setFooter({ text: 'Aurevon Ventures LLC' });
}

function buildJoinEmbed(member) {
  const age = Math.floor((Date.now() - member.user.createdTimestamp) / 86_400_000);
  return new EmbedBuilder()
    .setColor(GREEN)
    .setTitle('📥  Member Joined')
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      { name: 'User',         value: `<@${member.id}> (${member.user.tag})`, inline: true  },
      { name: 'Account Age',  value: `${age} day${age === 1 ? '' : 's'}`,   inline: true  },
      { name: 'Member #',     value: String(member.guild.memberCount),       inline: true  },
      { name: 'Joined',       value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: false },
    )
    .setFooter({ text: `ID: ${member.id}` })
    .setTimestamp();
}

function buildLeaveEmbed(member) {
  return new EmbedBuilder()
    .setColor(RED)
    .setTitle('📤  Member Left')
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      { name: 'User',   value: `${member.user.tag}`,       inline: true },
      { name: 'ID',     value: member.id,                  inline: true },
      { name: 'Roles',  value: member.roles.cache
          .filter(r => r.id !== member.guild.id)
          .map(r => r.name).join(', ') || 'None', inline: false },
    )
    .setTimestamp();
}

function buildRoleChangeEmbed(member, addedRoles, removedRoles) {
  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle('🔄  Role Update')
    .addFields({ name: 'Member', value: `<@${member.id}> (${member.user.tag})`, inline: false });
  if (addedRoles.size)   embed.addFields({ name: '✅  Added',   value: [...addedRoles.values()].map(r => r.name).join(', '),   inline: true });
  if (removedRoles.size) embed.addFields({ name: '❌  Removed', value: [...removedRoles.values()].map(r => r.name).join(', '), inline: true });
  return embed.setFooter({ text: `ID: ${member.id}` }).setTimestamp();
}

function buildBoostEmbed(member, action) {
  return new EmbedBuilder()
    .setColor(0xFF73FA)
    .setTitle(action === 'added' ? '🚀  New Server Boost!' : '💔  Boost Removed')
    .setThumbnail(member.user.displayAvatarURL())
    .setDescription(
      action === 'added'
        ? `Thank you <@${member.id}> for boosting **Aurevon Ventures**! 🎉`
        : `<@${member.id}> removed their server boost.`
    )
    .addFields({
      name:  'Current Boost Level',
      value: `Level ${member.guild.premiumTier} — ${member.guild.premiumSubscriptionCount} boost${member.guild.premiumSubscriptionCount === 1 ? '' : 's'}`,
      inline: false,
    })
    .setTimestamp();
}

// ── Channel helpers ───────────────────────────────────────────────────────────

function findChannel(guild, name) {
  return guild.channels.cache.find(c => c.name === name && c.type === ChannelType.GuildText) ?? null;
}

function findVoiceChannel(guild, name) {
  return guild.channels.cache.find(c => c.name === name && c.type === ChannelType.GuildVoice) ?? null;
}

async function sendLog(guild, channelName, payload) {
  const ch = findChannel(guild, channelName);
  if (!ch) return;
  await ch.send(payload).catch(err => console.warn(`[Bot] sendLog ${channelName}: ${err.message}`));
}

// ── Command handlers ──────────────────────────────────────────────────────────

async function handleSyncMember(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const email = interaction.options.getString('email').toLowerCase().trim();

  let mint;
  try { mint = await findActiveMintByEmail(email); }
  catch (e) { return interaction.editReply(`❌  Airtable error: ${e.message}`); }

  if (!mint) {
    return interaction.editReply(`❌  No active NFT mint found for \`${email}\`.\nMake sure the email matches the purchase email exactly.`);
  }

  const nftType = mint.fields['NFT Type'] ?? '';
  const entKey  = resolveEntitlementFromNftType(nftType);
  const roleId  = entKey ? getRoleId(entKey) : null;

  if (!roleId) {
    return interaction.editReply(`❌  No Discord role configured for NFT type: **${nftType}**\nCheck that DISCORD_ROLE_* env vars are set.`);
  }

  let memberRecord;
  try { memberRecord = await findMemberByEmail(email); }
  catch (e) { return interaction.editReply(`❌  Airtable member lookup failed: ${e.message}`); }

  const discordId = memberRecord?.fields?.['Discord ID'];
  if (!discordId) {
    return interaction.editReply(
      `⚠️  No Discord ID linked for \`${email}\`.\n` +
      `The member must complete OAuth verification first: ${SITE_URL}/member-claim.html`
    );
  }

  let guildMember;
  try { guildMember = await interaction.guild.members.fetch(discordId); }
  catch { return interaction.editReply(`❌  Discord user \`${discordId}\` is not in the server.`); }

  try {
    await guildMember.roles.add(roleId);
    await updateDiscordSyncStatus(email, 'synced');
  } catch (e) {
    return interaction.editReply(`❌  Role assignment failed: ${e.message}`);
  }

  const role = interaction.guild.roles.cache.get(roleId);
  const embed = goldEmbed('✅  Member Synced')
    .addFields(
      { name: 'Member',  value: `<@${discordId}>`,    inline: true },
      { name: 'Email',   value: email,                 inline: true },
      { name: 'Role',    value: role?.name ?? roleId,  inline: true },
      { name: 'NFT',     value: nftType,               inline: true },
    );

  await sendLog(interaction.guild, 'role-logs', { embeds: [embed] });
  return interaction.editReply({ embeds: [embed] });
}

// ─────────────────────────────────────────────────────────────────────────────

async function handleRevokeMember(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const targetUser = interaction.options.getUser('user');

  let guildMember;
  try { guildMember = await interaction.guild.members.fetch(targetUser.id); }
  catch { return interaction.editReply(`❌  <@${targetUser.id}> is not in this server.`); }

  const managed     = getAllManagedRoleIds();
  const toRemove    = guildMember.roles.cache.filter(r => managed.includes(r.id));

  if (toRemove.size === 0) {
    return interaction.editReply(`⚠️  <@${targetUser.id}> has no Aurevon-managed roles.`);
  }

  await guildMember.roles.remove([...toRemove.keys()]);

  const embed = goldEmbed('🚫  Roles Revoked')
    .addFields(
      { name: 'Member',        value: `<@${targetUser.id}>`,                             inline: true },
      { name: 'Roles Removed', value: [...toRemove.values()].map(r => r.name).join(', '), inline: false },
    );

  await sendLog(interaction.guild, 'role-logs', { embeds: [embed] });
  return interaction.editReply({ embeds: [embed] });
}

// ─────────────────────────────────────────────────────────────────────────────

async function handleStats(interaction) {
  await interaction.deferReply({ ephemeral: true });

  let members;
  try { members = await interaction.guild.members.fetch(); }
  catch (e) { return interaction.editReply(`❌  Could not fetch member list: ${e.message}`); }

  const humans   = members.filter(m => !m.user.bot);
  const bots     = members.filter(m => m.user.bot);
  const verified = process.env.DISCORD_ROLE_VERIFIED
    ? humans.filter(m => m.roles.cache.has(process.env.DISCORD_ROLE_VERIFIED))
    : null;

  const tierFields = Object.entries(ENTITLEMENT_MAP).map(([, cfg]) => {
    const roleId = process.env[cfg.discordRoleEnv];
    const count  = roleId ? members.filter(m => m.roles.cache.has(roleId)).size : 0;
    return { name: cfg.nftType, value: `**${count}**`, inline: true };
  });

  const embed = goldEmbed('📊  Aurevon Operators — Live Stats')
    .addFields(
      { name: '👥  Total Members',   value: `**${humans.size}**`,           inline: true },
      { name: '🤖  Bots',            value: `**${bots.size}**`,             inline: true },
      { name: '✅  Verified',        value: `**${verified?.size ?? '—'}**`, inline: true },
      { name: '​',              value: '​',                        inline: false },
      ...tierFields,
      { name: '​',              value: '​',                        inline: false },
      { name: '🚀  Boost Level',     value: `Level ${interaction.guild.premiumTier}`,                              inline: true },
      { name: '💎  Boosters',        value: `${interaction.guild.premiumSubscriptionCount}`,                       inline: true },
    );

  return interaction.editReply({ embeds: [embed] });
}

// ─────────────────────────────────────────────────────────────────────────────

async function handleLookup(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const email      = interaction.options.getString('email');
  const targetUser = interaction.options.getUser('user');

  if (!email && !targetUser) {
    return interaction.editReply({ content: '❌  Provide at least one of: `email` or `user`.' });
  }

  const lookupEmail = email?.toLowerCase().trim();

  let memberRecord, mintRecord;
  try {
    if (lookupEmail) {
      [memberRecord, mintRecord] = await Promise.all([
        findMemberByEmail(lookupEmail),
        findActiveMintByEmail(lookupEmail),
      ]);
    }
  } catch (e) {
    return interaction.editReply({ content: `❌  Airtable error: ${e.message}` });
  }

  if (lookupEmail && !memberRecord && !mintRecord) {
    return interaction.editReply({ content: `❌  No Airtable record found for \`${lookupEmail}\`.` });
  }

  // Resolve Discord ID — prefer Airtable record, fall back to @user option
  const discordId = memberRecord?.fields?.['Discord ID'] ?? targetUser?.id ?? null;
  const nftType   = mintRecord?.fields?.['NFT Type']            ?? '—';
  const mintStatus = mintRecord?.fields?.['Mint Status']        ?? '—';
  const reference  = mintRecord?.fields?.['Reference']          ?? '—';
  const syncSt     = memberRecord?.fields?.['Discord Sync Status'] ?? '—';

  // Fetch guild member for Discord-side info
  let gm = null;
  if (discordId) {
    gm = await interaction.guild.members.fetch(discordId).catch(() => null);
  }

  const guildTag = gm ? `<@${discordId}>` : discordId ? `${discordId} (not in server)` : '—';
  const joinedAt = gm?.joinedAt ? `<t:${Math.floor(gm.joinedAt / 1000)}:D>` : '—';
  const tierRoles = gm
    ? gm.roles.cache
        .filter(r => getTierRoleIds().includes(r.id))
        .map(r => r.name).join(', ') || 'None'
    : '—';

  const embed = goldEmbed('🔍  Member Lookup')
    .addFields(
      { name: 'Email',        value: lookupEmail ?? '—', inline: true  },
      { name: 'Discord',      value: guildTag,            inline: true  },
      { name: 'Joined Server',value: joinedAt,            inline: true  },
      { name: 'Tier Roles',   value: tierRoles,           inline: false },
      { name: 'NFT Type',     value: nftType,             inline: true  },
      { name: 'Serial',       value: reference,           inline: true  },
      { name: 'Mint Status',  value: mintStatus,          inline: true  },
      { name: 'Sync Status',  value: syncSt,              inline: true  },
    );

  return interaction.editReply({ embeds: [embed] });
}

// ─────────────────────────────────────────────────────────────────────────────

async function handleAnnounce(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const message = interaction.options.getString('message');
  const title   = interaction.options.getString('title') ?? '📢  Aurevon Update';

  const announceCh = findChannel(interaction.guild, 'announcements');
  if (!announceCh) return interaction.editReply({ content: '❌  #announcements channel not found. Run `discord/setup.js` first.' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Visit Aurevon').setStyle(ButtonStyle.Link).setURL(SITE_URL).setEmoji('🌐'),
  );

  const embed = goldEmbed(title).setDescription(message);
  await announceCh.send({ embeds: [embed], components: [row] });
  return interaction.editReply({ content: `✅  Posted to <#${announceCh.id}>` });
}

// ─────────────────────────────────────────────────────────────────────────────

async function handleWelcomeDm(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const targetUser = interaction.options.getUser('user');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Member Portal').setStyle(ButtonStyle.Link)
      .setURL(`${SITE_URL}/member-claim.html`).setEmoji('🔑'),
    new ButtonBuilder().setLabel('Visit Aurevon').setStyle(ButtonStyle.Link)
      .setURL(SITE_URL).setEmoji('🌐'),
  );

  try {
    await targetUser.send({ embeds: [buildWelcomeDmEmbed()], components: [row] });
    return interaction.editReply(`✅  Welcome DM sent to <@${targetUser.id}>.`);
  } catch {
    return interaction.editReply(`⚠️  Could not DM <@${targetUser.id}> — they may have DMs disabled.`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function handleEventCreate(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const title       = interaction.options.getString('title');
  const description = interaction.options.getString('description');
  const startRaw    = interaction.options.getString('start_time');
  const channelName = interaction.options.getString('channel') ?? 'Deal Room';

  const startTime = new Date(startRaw);
  if (isNaN(startTime.getTime())) {
    return interaction.editReply('❌  Invalid `start_time`. Use ISO 8601 format: `2025-06-01T18:00:00Z`');
  }
  if (startTime < new Date()) {
    return interaction.editReply('❌  `start_time` must be in the future.');
  }

  const voiceCh = findVoiceChannel(interaction.guild, channelName);
  if (!voiceCh) {
    return interaction.editReply(`❌  Voice channel **${channelName}** not found. Run \`discord/setup.js\` first.`);
  }

  let event;
  try {
    event = await interaction.guild.scheduledEvents.create({
      name:               title,
      description,
      scheduledStartTime: startTime,
      privacyLevel:       GuildScheduledEventPrivacyLevel.GuildOnly,
      entityType:         GuildScheduledEventEntityType.Voice,
      channel:            voiceCh,
    });
  } catch (e) {
    return interaction.editReply(`❌  Failed to create event: ${e.message}`);
  }

  const embed = goldEmbed('📅  Event Created')
    .setDescription(description)
    .addFields(
      { name: '📌  Title',    value: title,                                   inline: true },
      { name: '🎙️  Channel', value: voiceCh.name,                             inline: true },
      { name: '🕐  Start',   value: `<t:${Math.floor(startTime / 1000)}:F>`,  inline: false },
    );
  if (event.url) embed.setURL(event.url);

  const announceCh = findChannel(interaction.guild, 'announcements');
  if (announceCh) await announceCh.send({ embeds: [embed] });

  return interaction.editReply({ content: '✅  Event created and announced.', embeds: [embed] });
}

// ─────────────────────────────────────────────────────────────────────────────

async function handleSyncAll(interaction) {
  await interaction.deferReply({ ephemeral: true });

  let pending;
  try { pending = await listPendingDiscordSync({ maxRecords: 100 }); }
  catch (e) { return interaction.editReply(`❌  Airtable error: ${e.message}`); }

  if (!pending.length) return interaction.editReply('✅  No members pending Discord sync.');

  let synced = 0, skipped = 0, failed = 0;
  const errors = [];

  for (const rec of pending) {
    const email     = rec.fields?.['Email'] ?? '';
    const discordId = rec.fields?.['Discord ID'];
    if (!email || !discordId) { skipped++; continue; }

    try {
      const mint = await findActiveMintByEmail(email);
      if (!mint) { skipped++; continue; }

      const nftType = mint.fields['NFT Type'] ?? '';
      const entKey  = resolveEntitlementFromNftType(nftType);
      const roleId  = entKey ? getRoleId(entKey) : null;
      if (!roleId) { skipped++; continue; }

      const gm = await interaction.guild.members.fetch(discordId).catch(() => null);
      if (!gm) { skipped++; continue; }

      await gm.roles.add(roleId);
      await updateDiscordSyncStatus(email, 'synced');
      synced++;
    } catch (err) {
      failed++;
      errors.push(`${email}: ${err.message}`);
      await updateDiscordSyncStatus(email, 'failed', { error: err.message }).catch(() => {});
    }
  }

  const embed = goldEmbed('🔄  Sync-All Complete')
    .addFields(
      { name: '✅  Synced',  value: String(synced),  inline: true },
      { name: '⏭️  Skipped', value: String(skipped), inline: true },
      { name: '❌  Failed',  value: String(failed),  inline: true },
    );
  if (errors.length) embed.addFields({ name: 'Errors (first 5)', value: errors.slice(0, 5).join('\n'), inline: false });

  await sendLog(interaction.guild, 'role-logs', { embeds: [embed] });
  return interaction.editReply({ embeds: [embed] });
}

// ─────────────────────────────────────────────────────────────────────────────

async function handleBoostStats(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const { guild } = interaction;

  const TIER_THRESHOLDS = [
    { tier: 0, boosts: 0,  label: 'No perks'                       },
    { tier: 1, boosts: 2,  label: '100MB uploads, custom emoji +50' },
    { tier: 2, boosts: 7,  label: '50MB audio, custom emoji +100'   },
    { tier: 3, boosts: 14, label: '100MB uploads, custom emoji +250' },
  ];

  const currentBoosts = guild.premiumSubscriptionCount ?? 0;
  const currentTier   = guild.premiumTier ?? 0;
  const next          = TIER_THRESHOLDS.find(t => t.tier === currentTier + 1);
  const progress      = next ? `${currentBoosts}/${next.boosts} boosts to Level ${next.tier}` : 'Max level reached 🏆';

  const boosters = (await guild.members.fetch())
    .filter(m => m.premiumSince !== null);

  const embed = new EmbedBuilder()
    .setColor(0xFF73FA)
    .setTitle('🚀  Server Boost Status')
    .addFields(
      { name: '📶  Boost Level',    value: `Level ${currentTier}`,              inline: true  },
      { name: '💎  Total Boosts',   value: String(currentBoosts),               inline: true  },
      { name: '👤  Boosters',       value: String(boosters.size),               inline: true  },
      { name: '📈  Next Milestone', value: progress,                             inline: false },
      { name: '🎁  Current Perks',  value: TIER_THRESHOLDS[currentTier].label,  inline: false },
    )
    .setFooter({ text: 'Boost Aurevon Ventures to unlock more perks!' })
    .setTimestamp();

  const iconURL = guild.iconURL({ dynamic: true });
  if (iconURL) embed.setThumbnail(iconURL);

  return interaction.editReply({ embeds: [embed] });
}

// ── AutoMod setup ─────────────────────────────────────────────────────────────

async function setupAutoMod(guild) {
  const existing = await guild.autoModerationRules.fetch().catch(() => null);
  if (!existing) return; // Missing Permissions — skip silently

  const existingNames = new Set(existing.map(r => r.name));

  const rules = [
    {
      name: 'Aurevon — Mention Spam',
      eventType:   AutoModerationRuleEventType.MessageSend,
      triggerType: AutoModerationRuleTriggerType.MentionSpam,
      triggerMetadata: { mentionTotalLimit: 5 },
      actions: [
        { type: AutoModerationActionType.BlockMessage, metadata: { customMessage: 'Too many mentions. Please keep discussions focused.' } },
        { type: AutoModerationActionType.SendAlertMessage, metadata: { channel: guild.channels.cache.find(c => c.name === 'mod-actions')?.id } },
      ],
      enabled: true,
    },
    {
      name: 'Aurevon — Spam Filter',
      eventType:   AutoModerationRuleEventType.MessageSend,
      triggerType: AutoModerationRuleTriggerType.Spam,
      actions: [
        { type: AutoModerationActionType.BlockMessage },
      ],
      enabled: true,
    },
    {
      name: 'Aurevon — Keyword Filter',
      eventType:   AutoModerationRuleEventType.MessageSend,
      triggerType: AutoModerationRuleTriggerType.Keyword,
      triggerMetadata: {
        keywordFilter: [
          '*guaranteed returns*', '*risk-free investment*', '*100% profit*',
          '*send crypto*', '*dm me for deal*', '*pump and dump*', '*rug pull*',
          '*ponzi*', '*multi-level*', '*get rich quick*',
        ],
      },
      actions: [
        { type: AutoModerationActionType.BlockMessage, metadata: { customMessage: 'This content violates Aurevon community standards.' } },
        { type: AutoModerationActionType.SendAlertMessage, metadata: { channel: guild.channels.cache.find(c => c.name === 'mod-actions')?.id } },
      ],
      enabled: true,
    },
  ];

  for (const rule of rules) {
    if (existingNames.has(rule.name)) continue;

    // Filter out SendAlertMessage actions if mod-actions channel doesn't exist yet
    rule.actions = rule.actions.filter(a =>
      a.type !== AutoModerationActionType.SendAlertMessage || a.metadata?.channel != null
    );

    await guild.autoModerationRules.create(rule).catch(err =>
      console.warn(`[Bot] AutoMod "${rule.name}" skipped: ${err.message}`)
    );
    console.log(`[Bot] ✅  AutoMod rule created: ${rule.name}`);
  }
}

// ── Event handlers ────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async () => {
  console.log(`\n⬛  Aurevon Bot online as ${client.user.tag}`);
  console.log(`    Guild ID: ${GUILD_ID}`);
  console.log(`    Site:     ${SITE_URL}\n`);

  client.user.setPresence({
    activities: [{ name: 'Aurevon Operators | /verify', type: ActivityType.Watching }],
    status: 'online',
  });

  try {
    await registerCommands(client.user.id);
  } catch (e) {
    console.error(`[Bot] Command registration failed: ${e.message}`);
  }

  const guild = client.guilds.cache.get(GUILD_ID) ?? await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (guild) {
    await setupAutoMod(guild);
    await sendLog(guild, 'bot-commands', {
      embeds: [goldEmbed('🟢  Aurevon Bot Online').setDescription(`Ready in **${guild.name}**. ${COMMANDS.length} slash commands registered.`)],
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

client.on(Events.GuildMemberAdd, async (member) => {
  if (member.guild.id !== GUILD_ID) return;

  // Welcome DM
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Member Portal').setStyle(ButtonStyle.Link)
      .setURL(`${SITE_URL}/member-claim.html`).setEmoji('🔑'),
    new ButtonBuilder().setLabel('Visit Aurevon').setStyle(ButtonStyle.Link)
      .setURL(SITE_URL).setEmoji('🌐'),
  );
  member.send({ embeds: [buildWelcomeDmEmbed()], components: [row] }).catch(() => {});

  // Join log
  await sendLog(member.guild, 'join-logs', { embeds: [buildJoinEmbed(member)] });
});

// ─────────────────────────────────────────────────────────────────────────────

client.on(Events.GuildMemberRemove, async (member) => {
  if (member.guild.id !== GUILD_ID) return;
  await sendLog(member.guild, 'join-logs', { embeds: [buildLeaveEmbed(member)] });
});

// ─────────────────────────────────────────────────────────────────────────────

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  if (newMember.guild.id !== GUILD_ID) return;

  // ── Boost detection ───────────────────────────────────────────────────────
  const wasBoosting  = oldMember.premiumSince !== null;
  const nowBoosting  = newMember.premiumSince !== null;
  if (!wasBoosting && nowBoosting) {
    const ch = findChannel(newMember.guild, 'announcements');
    if (ch) await ch.send({ embeds: [buildBoostEmbed(newMember, 'added')] }).catch(() => {});
    await sendLog(newMember.guild, 'role-logs', { embeds: [buildBoostEmbed(newMember, 'added')] });
  }
  if (wasBoosting && !nowBoosting) {
    await sendLog(newMember.guild, 'role-logs', { embeds: [buildBoostEmbed(newMember, 'removed')] });
  }

  // ── Role change detection ─────────────────────────────────────────────────
  const tierIds    = getTierRoleIds();
  const addedRoles = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id) && tierIds.includes(r.id));
  const removedRoles = oldMember.roles.cache.filter(r => !newMember.roles.cache.has(r.id) && tierIds.includes(r.id));
  if (addedRoles.size || removedRoles.size) {
    await sendLog(newMember.guild, 'role-logs', { embeds: [buildRoleChangeEmbed(newMember, addedRoles, removedRoles)] });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

client.on(Events.GuildScheduledEventCreate, async (event) => {
  if (event.guildId !== GUILD_ID) return;
  const guild = event.guild ?? client.guilds.cache.get(GUILD_ID);
  if (!guild) return;

  const embed = goldEmbed(`📅  New Event: ${event.name}`)
    .setDescription(event.description ?? 'A new Aurevon event has been scheduled.')
    .addFields({ name: '🕐  Starts', value: `<t:${Math.floor(event.scheduledStartTimestamp / 1000)}:F>`, inline: true });
  if (event.url) embed.setURL(event.url);

  await sendLog(guild, 'announcements', { embeds: [embed] });
});

// ─────────────────────────────────────────────────────────────────────────────

client.on(Events.GuildScheduledEventUpdate, async (oldEvent, newEvent) => {
  if (newEvent.guildId !== GUILD_ID) return;
  if (newEvent.status !== GuildScheduledEventStatus.Active || oldEvent?.status === GuildScheduledEventStatus.Active) return;

  const guild = newEvent.guild ?? client.guilds.cache.get(GUILD_ID);
  if (!guild) return;

  const embed = goldEmbed(`🔴  LIVE: ${newEvent.name}`)
    .setDescription(newEvent.description ?? 'An Aurevon event is now live!')
    .addFields({ name: '🎙️  Channel', value: newEvent.channel?.name ?? 'See server', inline: true });
  if (newEvent.url) embed.setURL(newEvent.url);

  await sendLog(guild, 'announcements', { embeds: [embed] });
});

// ─────────────────────────────────────────────────────────────────────────────

// Discord premium app subscription entitlement (when users purchase bot premium)
client.on(Events.EntitlementCreate, async (entitlement) => {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;

  const user = await client.users.fetch(entitlement.userId).catch(() => null);
  const embed = goldEmbed('💎  New Premium Subscriber')
    .setDescription(`<@${entitlement.userId}> subscribed to Aurevon premium!`)
    .addFields({ name: 'SKU ID', value: entitlement.skuId ?? '—', inline: true });

  if (user) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('Visit Aurevon').setStyle(ButtonStyle.Link).setURL(SITE_URL),
    );
    user.send({ embeds: [goldEmbed('🎉  Welcome to Aurevon Premium!').setDescription(
      'Your premium subscription is active. Visit the member portal to link your Discord and unlock tier channels.'
    )], components: [row] }).catch(() => {});
  }

  await sendLog(guild, 'announcements', { embeds: [embed] });
  await sendLog(guild, 'role-logs',     { embeds: [embed] });
});

// ─────────────────────────────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const handlers = {
    'sync-member':   handleSyncMember,
    'revoke-member': handleRevokeMember,
    'stats':         handleStats,
    'lookup':        handleLookup,
    'announce':      handleAnnounce,
    'welcome-dm':    handleWelcomeDm,
    'sync-all':      handleSyncAll,
    'boost-stats':   handleBoostStats,
  };

  if (interaction.commandName === 'event') {
    const sub = interaction.options.getSubcommand(false);
    if (sub === 'create') return handleEventCreate(interaction);
    return interaction.reply({ content: '❌  Unknown subcommand.', ephemeral: true });
  }

  const handler = handlers[interaction.commandName];
  if (!handler) return interaction.reply({ content: '❌  Unknown command.', ephemeral: true });

  handler(interaction).catch(async err => {
    console.error(`[Bot] Command /${interaction.commandName} threw:`, err);
    const msg = { content: `❌  Internal error: ${err.message}`, ephemeral: true };
    await (interaction.deferred || interaction.replied
      ? interaction.editReply(msg)
      : interaction.reply(msg)
    ).catch(() => {});
  });
});

// ── Unhandled rejections ──────────────────────────────────────────────────────

process.on('unhandledRejection', err => {
  console.error('[Bot] Unhandled rejection:', err);
});

process.on('SIGINT', () => {
  console.log('\n[Bot] Shutting down gracefully...');
  client.destroy();
  process.exit(0);
});

// ── Login ─────────────────────────────────────────────────────────────────────

console.log('[Bot] Connecting to Discord...');
client.login(TOKEN).catch(err => {
  console.error(`[Bot] Login failed: ${err.message}`);
  if (err.message.includes('TOKEN_INVALID')) {
    console.error('      → Check DISCORD_BOT_TOKEN in your .env file.');
  }
  process.exit(1);
});
