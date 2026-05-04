import { createHmac, timingSafeEqual } from 'node:crypto';

const SECRET = process.env.STATE_SECRET ?? 'change-me-32-chars-placeholder!!';

/**
 * Sign an email address and return a state string: `email.HMAC16`
 * @param {string} email
 * @returns {string}
 */
export function signState(email) {
  const mac = createHmac('sha256', SECRET)
    .update(email)
    .digest('hex')
    .slice(0, 16);
  return `${email}.${mac}`;
}

/**
 * Verify a state string. Returns the email on success, throws on failure.
 * @param {string} state
 * @returns {string} email
 */
export function verifyState(state) {
  const lastDot = state.lastIndexOf('.');
  if (lastDot === -1) throw new Error('Invalid state format');

  const email = state.slice(0, lastDot);
  const receivedMac = state.slice(lastDot + 1);

  const expectedMac = createHmac('sha256', SECRET)
    .update(email)
    .digest('hex')
    .slice(0, 16);

  const a = Buffer.from(receivedMac.padEnd(32, '0'));
  const b = Buffer.from(expectedMac.padEnd(32, '0'));

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('State HMAC verification failed');
  }

  return email;
}
