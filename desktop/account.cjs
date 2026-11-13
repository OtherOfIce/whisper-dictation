const fs = require('node:fs/promises');
const os = require('node:os');
const vault = require('./vault.cjs');
const { validateUrl } = require('./dictionary-sync.cjs');

const MIN_PASSPHRASE = 12;
class SignedOutError extends Error {}
const empty = () => ({ url: '', username: '', token: '', name: '', admin: false, grants: null, keyring: null, recoveryKey: '', serverVersion: 1 });
const FULL_GRANTS = { secrets: true, settings: true, history: false, dictionary: 'Personal' };

// The sync account this device belongs to. Devices are linked peers: "Turn on sync" creates an account named by a
// random id and protected by a generated recovery key (see vault.newRecoveryKey); any linked device can then link
// another with a one-time code, or remove one. Accounts made before this, with an email and passphrase, keep working.
// The token and keyring are kept here, encrypted for the OS user. The recovery key is kept too, so it can be shown
// again; a passphrase is never stored.
class Account {
  constructor({ file, crypto, onChange = () => {}, fetchImpl = fetch, hostname = os.hostname }) {
    Object.assign(this, { file, crypto, onChange, fetchImpl, hostname });
    this.state = empty(); this.message = '';
  }
  status() {
    const { url, username, token, name, admin, grants } = this.state;
    const recovery = vault.isRecoveryUsername(username);
    return { signedIn: !!token, url, username: token && !recovery ? username : '', kind: recovery ? 'linked' : 'legacy', name, admin, grants,
      hasKeys: !!this.state.keyring?.secrets, hasRecoveryKey: !!this.state.recoveryKey, canManage: !!token && this.canManage(), message: this.message };
  }
  // Servers before version 2 only let devices signed in with the passphrase manage others.
  canManage() { return this.state.admin || this.state.serverVersion >= 2; }
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
    return this.save({ ...empty(), url: this.state.url }, 'This device was removed from sync. Link it again from another device to keep syncing.');
  }

  // Creates a new account for this device and returns its recovery key, which the user should keep somewhere safe.
  async turnOn(url) {
    const origin = validateUrl(url);
    const recoveryKey = vault.newRecoveryKey();
    const { username, secret } = vault.parseRecoveryKey(recoveryKey);
    const { authKey, wrapKey } = await vault.deriveAccount(username, secret);
    const keyring = vault.newKeyring();
    const reply = await this.post(origin, '/account/create', { username, authKey, keyring: vault.sealKeyring(wrapKey, keyring), deviceName: this.hostname() });
    await this.save({ ...empty(), url: origin, username: reply.username, token: reply.token, name: this.hostname(), admin: true, grants: reply.grants, keyring, recoveryKey });
    await this.refresh().catch(() => {});
    return recoveryKey;
  }
  // Joins an account again with its recovery key, when no linked device is at hand.
  async recover(url, recoveryKey) {
    const { username, secret, key } = vault.parseRecoveryKey(recoveryKey);
    await this.signIn(url, username, secret);
    await this.save({ ...this.state, recoveryKey: key });
    return this.status();
  }
  // Replaces the recovery key. Needs the current one, which this device keeps if it created or recovered the account.
  async newRecoveryKey() {
    if (!this.state.recoveryKey) throw new Error('This device does not have the current recovery key. Use the device that turned sync on.');
    const current = vault.parseRecoveryKey(this.state.recoveryKey);
    const recoveryKey = vault.newRecoveryKey(current.id);
    const { secret } = vault.parseRecoveryKey(recoveryKey);
    const [{ authKey: currentAuthKey }, { authKey, wrapKey }] = await Promise.all([vault.deriveAccount(current.username, current.secret), vault.deriveAccount(current.username, secret)]);
    await this.request('/account/passphrase', { currentAuthKey, authKey, keyring: vault.sealKeyring(wrapKey, this.state.keyring) });
    await this.save({ ...this.state, recoveryKey }, this.message);
    return recoveryKey;
  }
  recoveryKey() { return this.state.recoveryKey || null; }

  async signIn(url, username, passphrase) {
    const origin = validateUrl(url);
    const name = vault.normalizeUsername(username);
    const { authKey, wrapKey } = await vault.deriveAccount(name, passphrase);
    const reply = await this.post(origin, '/account/sign-in', { username: name, authKey, deviceName: this.hostname() });
    let keyring;
    try { keyring = vault.openKeyring(wrapKey, reply.keyring); }
    catch (error) { await this.post(origin, '/account/sign-out', {}, reply.token).catch(() => {}); throw error; }
    await this.save({ ...empty(), url: origin, username: reply.username, token: reply.token, name: this.hostname(), admin: true, grants: reply.grants, keyring });
    await this.refresh().catch(() => {});
    return this.status();
  }
  async pair(url, code) {
    const origin = validateUrl(url);
    const { pairId, key } = await vault.derivePairing(code);
    const reply = await this.post(origin, '/pair/claim', { pairId });
    let payload;
    try { payload = JSON.parse(vault.open(key, 'pairing', reply.payload)); }
    catch { await this.post(origin, '/account/sign-out', {}, reply.token).catch(() => {}); throw new Error('That pairing code did not match. Make a new one on your desktop.'); }
    await this.save({ ...empty(), url: origin, username: reply.username, token: reply.token, name: reply.name, admin: false, grants: reply.grants, keyring: payload.keyring ?? null });
    await this.refresh().catch(() => {});
    return this.status();
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
    const serverVersion = Number(me.version) || 1;
    const changed = JSON.stringify([me.grants, me.admin, me.name, serverVersion]) !== JSON.stringify([this.state.grants, this.state.admin, this.state.name, this.state.serverVersion]);
    return changed ? this.save({ ...this.state, grants: me.grants, admin: me.admin, name: me.name, serverVersion }, this.message) : this.status();
  }
  noteGrants(grants) {
    if (grants && JSON.stringify(grants) !== JSON.stringify(this.state.grants)) return this.save({ ...this.state, grants }, this.message);
  }

  // --- linked devices ---
  requireManage() { if (!this.canManage()) throw new Error('Update the sync server to manage devices from here, or use the desktop that turned sync on.'); }
  listDevices() { this.requireManage(); return this.request('/devices/list'); }
  // Makes a one-time code for a new device. It gets everything this device has: the keyring (when this device holds
  // the API-key key), shared settings and this device's dictionary list.
  async linkDevice(name = 'New device') {
    this.requireManage();
    const code = vault.generatePairCode();
    const { pairId, key } = await vault.derivePairing(code);
    const hasKeys = !!this.state.keyring?.secrets;
    const grants = { ...FULL_GRANTS, secrets: hasKeys, dictionary: this.state.grants?.dictionary ?? FULL_GRANTS.dictionary };
    const payload = vault.seal(key, 'pairing', JSON.stringify({ v: 1, keyring: hasKeys ? this.state.keyring : null }));
    const { expiresAt } = await this.request('/devices/pair', { name, grants, pairId, payload });
    return { code, expiresAt };
  }
  removeDevice(id) { this.requireManage(); return this.request('/devices/remove', { id }); }
}
module.exports = { Account, SignedOutError, MIN_PASSPHRASE };
