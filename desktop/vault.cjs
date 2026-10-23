// Client-side crypto for account sync. The format is shared with the Android app (VaultCrypto.kt); both are
// checked against the same fixed vectors in their tests.
//
//   envelope  = "v1." + base64(nonce, 12 bytes) + "." + base64(AES-256-GCM ciphertext || 16-byte tag)
//   AAD       = "local-whisper:v1:" + item name, so the server cannot move a sealed value to another item
//
// Account (Windows only): master = PBKDF2-HMAC-SHA256(NFKC(passphrase) trimmed, "local-whisper:account:" + username, 600000)
//   authKey = HMAC-SHA256(master, "auth")  sent to the server, which keeps only its hash
//   wrapKey = HMAC-SHA256(master, "wrap")  seals the keyring: one random 32-byte key per group (secrets, history)
// Pairing: master = PBKDF2-HMAC-SHA256(12-character code, "local-whisper:pair", 100000)
//   pairId = hex(HMAC-SHA256(master, "id")), key = HMAC-SHA256(master, "key") seals the payload for the new device
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const pbkdf2 = promisify(crypto.pbkdf2);

const ITERATIONS = 600000;
const PAIR_ITERATIONS = 100000;
const PAIR_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const aad = name => Buffer.from(`local-whisper:v1:${name}`);

const normalizePassphrase = passphrase => String(passphrase).normalize('NFKC').replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
const hmac = (key, label) => crypto.createHmac('sha256', key).update(label).digest();

function seal(key, name, plaintext, nonce = crypto.randomBytes(12)) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(name));
  const sealed = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return `v1.${nonce.toString('base64')}.${sealed.toString('base64')}`;
}

function open(key, name, envelope) {
  const [version, nonce, sealed] = String(envelope).split('.');
  if (version !== 'v1' || !nonce || !sealed) throw new Error('Unsupported sealed value.');
  const bytes = Buffer.from(sealed, 'base64');
  if (bytes.length < 16) throw new Error('Sealed value is damaged.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'));
  decipher.setAAD(aad(name));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - 16)), decipher.final()]).toString('utf8');
}

// The username is an email address used only as a name; it must match the server's normalisation.
function normalizeUsername(value) {
  const username = String(value ?? '').trim().toLowerCase();
  if (username.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)) throw new Error('Use an email address as your username.');
  return username;
}

async function deriveAccount(username, passphrase, iterations = ITERATIONS) {
  const password = normalizePassphrase(passphrase);
  if (!password) throw new Error('Enter your passphrase.');
  const master = await pbkdf2(password, Buffer.from(`local-whisper:account:${normalizeUsername(username)}`), iterations, 32, 'sha256');
  return { authKey: hmac(master, 'auth').toString('base64'), wrapKey: hmac(master, 'wrap') };
}

// One key per group that is sealed on the device. History has a key already so devices paired now can be
// given it once history sync exists, without pairing again.
const newKeyring = () => ({ v: 1, secrets: crypto.randomBytes(32).toString('base64'), history: crypto.randomBytes(32).toString('base64') });
const sealKeyring = (wrapKey, keyring) => seal(wrapKey, 'account:keyring', JSON.stringify(keyring));
function openKeyring(wrapKey, sealed) {
  let keyring;
  try { keyring = JSON.parse(open(wrapKey, 'account:keyring', sealed)); } catch { throw new Error('That passphrase does not open this account.'); }
  if (keyring?.v !== 1 || typeof keyring.secrets !== 'string') throw new Error('This account was set up by a newer version of the app.');
  return keyring;
}

// 12 characters from Crockford's base32 (60 bits), shown as XXXX-XXXX-XXXX.
function generatePairCode() {
  const bytes = crypto.randomBytes(12);
  const code = [...bytes].map(byte => PAIR_ALPHABET[byte & 31]).join('');
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}
// Accepts what people type: any case, spaces or hyphens, and O/I/L for 0/1. Returns null if it cannot be a code.
function normalizePairCode(value) {
  const code = String(value ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return code.length === 12 && [...code].every(char => PAIR_ALPHABET.includes(char)) ? code : null;
}
async function derivePairing(value, iterations = PAIR_ITERATIONS) {
  const code = normalizePairCode(value);
  if (!code) throw new Error('Enter the 12-character pairing code.');
  const master = await pbkdf2(code, Buffer.from('local-whisper:pair'), iterations, 32, 'sha256');
  return { pairId: hmac(master, 'id').toString('hex'), key: hmac(master, 'key') };
}

const digest = (name, value) => value === null || value === undefined ? null : crypto.createHash('sha256').update(`${name}\n${value}`).digest('hex');

// Decides what one synced item needs, from three views of it: the device's own value (as a digest), the
// account's latest, and the last state both agreed on. Digests keep API keys out of the saved bookkeeping.
//   remote: undefined, or { digest, updatedAt } (digest null = deleted)   base: undefined, or { digest, updatedAt }
// Returns { push?: { updatedAt }, pull?: true, base }. `pull` means take the account's value, `push` means
// send the device's. On first contact the account wins; afterwards a change on this device wins over one that
// arrived in the same interval, and otherwise the changed side wins.
function reconcile(localDigest, remote, base, now) {
  const remoteDigest = remote ? remote.digest : null;
  const pushAt = Math.max(now, (remote?.updatedAt ?? 0) + 1);
  if (!base) {
    if (remoteDigest !== null) return { pull: remoteDigest !== localDigest, base: { digest: remoteDigest, updatedAt: remote.updatedAt } };
    if (localDigest !== null) return { push: { updatedAt: pushAt } };
    return { base: { digest: null, updatedAt: remote?.updatedAt ?? 0 } };
  }
  if (localDigest !== base.digest) {
    if (remote && localDigest === remoteDigest) return { base: { digest: remoteDigest, updatedAt: remote.updatedAt } };
    return { push: { updatedAt: pushAt } };
  }
  if (remote && remote.updatedAt > base.updatedAt) return { pull: remoteDigest !== localDigest, base: { digest: remoteDigest, updatedAt: remote.updatedAt } };
  return { base };
}

module.exports = { ITERATIONS, PAIR_ITERATIONS, normalizePassphrase, normalizeUsername, deriveAccount, newKeyring, sealKeyring, openKeyring, generatePairCode, normalizePairCode, derivePairing, seal, open, digest, reconcile };
