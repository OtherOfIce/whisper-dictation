// Accounts are a username (an email address, never mailed) and a passphrase. The passphrase never reaches the
// server: the Windows app derives an auth key from it, and the server keeps only that key's SHA-256.
export const MAX_DEVICES = 20;
export const MAX_FAILURES_PER_HOUR = 10;
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const TOKEN_PATTERN = /^lwd_[A-Za-z0-9_-]{43}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ENVELOPE = /^v1\.[A-Za-z0-9+/=]{16}\.[A-Za-z0-9+/=]{24,4000}$/;
export const GROUPS = ['secrets', 'settings', 'history'];
export const ALL_GRANTS = { secrets: true, settings: true, history: false, dictionary: 'Personal' };

export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

// Who may create an account. With ALLOWED_EMAILS unset anyone who knows the deployment URL can; set it to close
// sign-up to the listed usernames. Existing accounts can always sign in.
export function mayCreate(email, list = process.env.ALLOWED_EMAILS) {
  const entries = (list ?? '').split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean);
  return entries.length === 0 || entries.includes(email);
}

export const isAuthKey = value => typeof value === 'string' && value.length === 44 && BASE64.test(value);
export const isEnvelope = value => typeof value === 'string' && ENVELOPE.test(value);
export const isPairId = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export const deviceName = (value, fallback = 'Device') => typeof value === 'string' && value.trim() ? value.trim().slice(0, 60) : fallback;
export const isListName = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _-]{0,29}$/.test(value);

// Returns the cleaned grants, or null if they are malformed. History cannot be granted until it exists.
export function validateGrants(value) {
  if (!value || typeof value !== 'object') return null;
  if (!['secrets', 'settings'].every(group => typeof value[group] === 'boolean')) return null;
  const dictionary = value.dictionary ?? null;
  if (dictionary !== null && !isListName(dictionary)) return null;
  return { secrets: value.secrets, settings: value.settings, history: false, dictionary };
}

export function generateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return 'lwd_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export const hashAuthKey = authKey => sha256Hex(`auth-key:${authKey}`);
