/**
 * Discord Bot API helper — role management via bot token (not OAuth).
 *
 * Bot token must have:
 *   - GUILD_MEMBERS intent (Privileged) enabled in Discord Developer Portal
 *   - "Manage Roles" permission
 *   - Bot role positioned ABOVE the roles it will assign/remove
 */

const DISCORD_API = 'https://discord.com/api/v10';

function getGuildId() {
  const id = process.env.DISCORD_GUILD_ID;
  if (!id) throw new Error('Missing DISCORD_GUILD_ID env var');
  return id;
}

function getBotHeaders() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('Missing DISCORD_BOT_TOKEN env var');
  return {
    Authorization: `Bot ${token}`,
    'Content-Type': 'application/json',
  };
}

async function discordApiError(res, context) {
  const body = await res.text().catch(() => '');
  throw new Error(`Discord bot [${context}] (${res.status}): ${body}`);
}

/**
 * Get a guild member by Discord user ID.
 * Returns null if not a member of the guild.
 *
 * @param {string} discordId
 */
export async function getGuildMember(discordId) {
  const res = await fetch(`${DISCORD_API}/guilds/${getGuildId()}/members/${discordId}`, {
    headers: getBotHeaders(),
  });
  if (res.status === 404) return null;
  if (!res.ok) await discordApiError(res, `getGuildMember(${discordId})`);
  return res.json();
}

/**
 * Add a Discord role to a guild member.
 * Idempotent — safe to call if the member already has the role.
 *
 * @param {string} discordId
 * @param {string} roleId
 */
export async function addRoleToMember(discordId, roleId) {
  const res = await fetch(
    `${DISCORD_API}/guilds/${getGuildId()}/members/${discordId}/roles/${roleId}`,
    { method: 'PUT', headers: getBotHeaders(), body: JSON.stringify({}) },
  );
  // 204 = success, 404 = member not found in guild
  if (res.status === 404) {
    throw new Error(`Discord member ${discordId} not found in guild — they must join first`);
  }
  if (res.status !== 204) await discordApiError(res, `addRoleToMember(${discordId}, ${roleId})`);
}

/**
 * Remove a Discord role from a guild member.
 * Idempotent — safe to call if the member doesn't have the role.
 *
 * @param {string} discordId
 * @param {string} roleId
 */
export async function removeRoleFromMember(discordId, roleId) {
  const res = await fetch(
    `${DISCORD_API}/guilds/${getGuildId()}/members/${discordId}/roles/${roleId}`,
    { method: 'DELETE', headers: getBotHeaders() },
  );
  if (res.status === 404) return; // member not found — treat as success
  if (res.status !== 204) await discordApiError(res, `removeRoleFromMember(${discordId}, ${roleId})`);
}

/**
 * Add a member to the guild (requires their OAuth access token).
 * Used during the OAuth callback flow.
 *
 * @param {string} discordId
 * @param {string} oauthAccessToken  — from user's Discord OAuth exchange
 * @param {string[]} roleIds         — roles to assign immediately on join
 */
export async function addMemberToGuild(discordId, oauthAccessToken, roleIds = []) {
  const res = await fetch(`${DISCORD_API}/guilds/${getGuildId()}/members/${discordId}`, {
    method: 'PUT',
    headers: getBotHeaders(),
    body: JSON.stringify({ access_token: oauthAccessToken, roles: roleIds }),
  });
  if (![200, 201, 204].includes(res.status)) {
    await discordApiError(res, `addMemberToGuild(${discordId})`);
  }
}

/**
 * Sync a member's entitlement roles.
 * Assigns targetRoleId. Optionally removes obsolete roles (other entitlement roles).
 *
 * @param {string} discordId
 * @param {string} targetRoleId         — role to assign
 * @param {string[]} obsoleteRoleIds    — roles to remove (e.g. old tier)
 */
export async function syncMemberRoles(discordId, targetRoleId, obsoleteRoleIds = []) {
  // Assign the target role first
  await addRoleToMember(discordId, targetRoleId);

  // Remove any obsolete roles (best-effort, non-fatal)
  for (const rid of obsoleteRoleIds) {
    if (rid && rid !== targetRoleId) {
      await removeRoleFromMember(discordId, rid).catch((err) =>
        console.warn(`[Discord Bot] Could not remove role ${rid}: ${err.message}`)
      );
    }
  }
}
