/**
 * GET /api/discord/auth?email=customer@example.com
 *
 * Initiates the Discord OAuth2 flow. Builds a signed state param containing
 * the customer email, then redirects to the Discord consent screen.
 *
 * Required env vars:
 *   DISCORD_CLIENT_ID, DOMAIN, STATE_SECRET
 */

import { signState } from './lib/sign.js';

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DOMAIN = process.env.DOMAIN ?? 'https://yourdomain.com';
const REDIRECT_URI = `${DOMAIN}/api/discord/callback`;
const DISCORD_OAUTH_BASE = 'https://discord.com/api/oauth2/authorize';
const SCOPES = 'identify guilds.join';

export default function handler(req, res) {
  const { email } = req.query ?? {};

  if (!email || typeof email !== 'string') {
    res.status(400).json({ error: 'Missing required query param: email' });
    return;
  }

  // Basic email sanity check
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'Invalid email format' });
    return;
  }

  // Sign the state so we can verify it on callback without a session store
  const state = signState(email.toLowerCase().trim());

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    state: state,
    // prompt=none skips the consent screen for already-authorized apps
    prompt: 'consent',
  });

  const oauthUrl = `${DISCORD_OAUTH_BASE}?${params.toString()}`;

  res.redirect(302, oauthUrl);
}
