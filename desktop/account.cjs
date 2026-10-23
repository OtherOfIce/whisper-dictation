const fs = require('node:fs/promises');
const os = require('node:os');
const vault = require('./vault.cjs');
const { validateUrl } = require('./dictionary-sync.cjs');

const MIN_PASSPHRASE = 12;
class SignedOutError extends Error {}
const empty = () => ({ url: '', username: '', token: '', name: '', admin: false, grants: null, keyring: null });

// The account this device belongs to. A Windows desktop creates the account or signs in with the username and
// passphrase, which makes it an admin device that can pair others. Any device can instead be paired with a
// one-time code from an admin device. The token, grants and the group keys this device was given are kept here,
// encrypted for the OS user; the passphrase itself is never stored.
class Account {
  constructor({ file, crypto, onChange = () => {}, fetchImpl = fetch, hostname = os.hostname }) {
    Object.assign(this, { file, crypto, onChange, fetchImpl, hostname });
    this.state = empty(); this.message = '';
  }
  status() {
    const { url, username, token, name, admin, grants } = this.state;
    return { signedIn: !!token, url, username: token ? username : '', name, admin, grants, hasKeys: !!this.state.keyring?.secrets, message: this.message };
  }
  session() { return this.state.token ? { url: this.state.url, token: this.state.token } : null; }
  keyFor(group) { const key = this.state.keyring?.[group]; return key ? Buffer.from(key, 'base64') : null; }
  async load() {
    try { this.state = { ...empty(), ...JSON.parse(this.crypto.decryptString(await fs.readFile(this.file))) }; }
    catch { /* No saved account: signed out. */ }
  }
  async persist() {
    await fs.writeFile(this.file + '.tmp', this.crypto.encryptString(JSON.stringify(this.state)));
    await fs.rename(this.file + '.tmp', this.file);
  }
  async save(state, message = '') {
    const previous = this.state;
    this.state = state;
    try { await this.persist(); } catch (error) { this.state = previous; throw error; }
    this.message = message; this.onChange(this.status());
    return this.status();
  }

  async post(url, path, body, token) {
    const response = await this.fetchImpl(url + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000), redirect: 'error'
    });
    const parsed = await response.json().catch(() => null);
    if (response.status === 401 && token) { await this.dropped(); throw new SignedOutError('This device was signed out. Sign in again to keep syncing.'); }
    if (!response.ok) throw new Error(typeof parsed?.error === 'string' && parsed.error ? parsed.error : `Request failed (${response.status})`);
    return parsed ?? {};
  }
  // For other modules syncing with this account's token.
  request(path, body = {}) {
    const session = this.session();
    if (!session) return Promise.reject(new Error('Sign in to sync'));
    return this.post(session.url, path, body, session.token);
  }
  // The server no longer knows this device: removed from another device, or its passphrase was changed.
  dropped() {
    const again = this.state.admin ? 'Sign in again' : 'Pair it again from your desktop';
    return this.save({ ...empty(), url: this.state.url }, `This device was signed out. ${again} to keep syncing.`);
  }

  async createAccount(url, username, passphrase) {
    const origin = validateUrl(url);
    const name = vault.normalizeUsername(username);
    if (vault.normalizePassphrase(String(passphrase ?? '')).length < MIN_PASSPHRASE) throw new Error(`Choose a passphrase of at least ${MIN_PASSPHRASE} characters. It protects your API keys.`);
    const { authKey, wrapKey } = await vault.deriveAccount(name, passphrase);
    const keyring = vault.newKeyring();
    const reply = await this.post(origin, '/account/create', { username: name, authKey, keyring: vault.sealKeyring(wrapKey, keyring), deviceName: this.hostname() });
    return this.save({ url: origin, username: reply.username, token: reply.token, name: this.hostname(), admin: true, grants: reply.grants, keyring });
  }
  async signIn(url, username, passphrase) {
    const origin = validateUrl(url);
    const name = vault.normalizeUsername(username);
    const { authKey, wrapKey } = await vault.deriveAccount(name, passphrase);
    const reply = await this.post(origin, '/account/sign-in', { username: name, authKey, deviceName: this.hostname() });
    let keyring;
    try { keyring = vault.openKeyring(wrapKey, reply.keyring); }
    catch (error) { await this.post(origin, '/account/sign-out', {}, reply.token).catch(() => {}); throw error; }
    return this.save({ url: origin, username: reply.username, token: reply.token, name: this.hostname(), admin: true, grants: reply.grants, keyring });
  }
  async pair(url, code) {
    const origin = validateUrl(url);
    const { pairId, key } = await vault.derivePairing(code);
    const reply = await this.post(origin, '/pair/claim', { pairId });
    let payload;
    try { payload = JSON.parse(vault.open(key, 'pairing', reply.payload)); }
    catch { await this.post(origin, '/account/sign-out', {}, reply.token).catch(() => {}); throw new Error('That pairing code did not match. Make a new one on your desktop.'); }
    return this.save({ url: origin, username: reply.username, token: reply.token, name: reply.name, admin: false, grants: reply.grants, keyring: payload.keyring ?? null });
  }
  async signOut() {
    const session = this.session();
    let revoked = true;
    if (session) revoked = await this.post(session.url, '/account/sign-out', {}, session.token).then(() => true, () => false);
    return this.save({ ...empty(), url: this.state.url }, revoked ? 'Signed out' : 'Signed out on this device. The server could not be reached to remove it.');
  }
  // Picks up grant changes made on an admin device.
  async refresh() {
    if (!this.session()) return this.status();
    const me = await this.request('/account/me');
    const changed = JSON.stringify([me.grants, me.admin, me.name]) !== JSON.stringify([this.state.grants, this.state.admin, this.state.name]);
    return changed ? this.save({ ...this.state, grants: me.grants, admin: me.admin, name: me.name }, this.message) : this.status();
  }
  noteGrants(grants) {
    if (grants && JSON.stringify(grants) !== JSON.stringify(this.state.grants)) return this.save({ ...this.state, grants }, this.message);
  }

  // --- managing devices (admin devices only) ---
  requireAdmin() { if (!this.state.admin) throw new Error('Only a desktop signed in with the passphrase can manage devices.'); }
  listDevices() { this.requireAdmin(); return this.request('/devices/list'); }
  // Makes a one-time code. Only the keys for granted groups go into the sealed payload, so a device without
  // API keys can never decrypt them.
  async addDevice({ name, grants }) {
    this.requireAdmin();
    const code = vault.generatePairCode();
    const { pairId, key } = await vault.derivePairing(code);
    const keyring = grants.secrets ? { v: 1, secrets: this.state.keyring.secrets } : null;
    const payload = vault.seal(key, 'pairing', JSON.stringify({ v: 1, keyring }));
    const { expiresAt } = await this.request('/devices/pair', { name, grants, pairId, payload });
    return { code, expiresAt };
  }
  async updateDevice(id, changes) {
    this.requireAdmin();
    await this.request('/devices/update', { id, ...changes });
    return this.refresh();
  }
  removeDevice(id) { this.requireAdmin(); return this.request('/devices/remove', { id }); }
  async changePassphrase(passphrase) {
    this.requireAdmin();
    if (vault.normalizePassphrase(String(passphrase ?? '')).length < MIN_PASSPHRASE) throw new Error(`Choose a passphrase of at least ${MIN_PASSPHRASE} characters.`);
    const { authKey, wrapKey } = await vault.deriveAccount(this.state.username, passphrase);
    await this.request('/account/passphrase', { authKey, keyring: vault.sealKeyring(wrapKey, this.state.keyring) });
    this.message = 'Passphrase changed. Other desktops signed in with the old one were signed out.';
    this.onChange(this.status());
    return this.status();
  }
}
module.exports = { Account, SignedOutError, MIN_PASSPHRASE };
