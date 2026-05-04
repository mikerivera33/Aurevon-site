const DISCORD_API = 'https://discord.com/api/v10';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const DOMAIN = process.env.DOMAIN ?? 'https://yourdomain.com';
const REDIRECT_URI = `${DOMAIN}/api/discord/callback`;

/**
 * Handle Discord API error responses with meaningful messages.
 * @param {Response} res
 * @param {string} context
 */
async function handleError(res, context) {
  if (res.status === 401) throw new Error('Bot token invalid');
  if (res.status === 403) throw new Error('Missing permissions');
  const body = await res.text().catch(() => '(no body)');
  throw new Error(`Discord ${context} failed [${res.status}]: ${body}`);
}

/**
 * Exchange an OAuth2 code for an access token.
 * @param {string} code
 * @returns {Promise<{ access_token: string, token_type: string, scope: string }>}
 */
export async function exchangeCode(code) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
  });

  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) await handleError(res, 'token exchange');
  return res.json();
}

/**
 * Fetch the authenticated Discord user.
 * @param {string} accessToken
 * @returns {Promise<{ id: string, username: string, discriminator: string, email?: string }>}
 */
export async function getUser(accessToken) {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) await handleError(res, 'get user');
  return res.json();
}

/**
 * Add a user to the guild (or update their roles if already a member).
 * Uses the user's OAuth access_token which must include guilds.join scope.
 * @param {string} userId
 * @param {string} accessToken  — user OAuth token
 * @param {string[]} roleIds
 * @returns {Promise<void>}
 */
export async function addMemberToGuild(userId, accessToken, roleIds) {
  const res = await fetch(`${DISCORD_API}/guilds/${GUILD_ID}/members/${userId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ access_token: accessToken, roles: roleIds }),
  });

  // 201 = added, 204 = already in guild (roles may not update via this route alone)
  if (res.status === 201 || res.status === 204) return;
  // 200 also valid in some versions
  if (res.status === 200) return;
  await handleError(res, 'add member to guild');
}

/**
 * Assign a single role to an existing guild member.
 * @param {string} userId
 * @param {string} roleId
 * @returns {Promise<void>}
 */
export async function assignRole(userId, roleId) {
  const res = await fetch(
    `${DISCORD_API}/guilds/${GUILD_ID}/members/${userId}/roles/${roleId}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    },
  );

  if (res.status === 204) return;
  await handleError(res, 'assign role');
}
