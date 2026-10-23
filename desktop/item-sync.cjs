const fs = require('node:fs/promises');
const vault = require('./vault.cjs');
const { SignedOutError } = require('./account.cjs');

const isSecret = name => name.startsWith('secrets.');
const ITEM_NAME = /^(settings|secrets)\.[a-z][A-Za-z0-9]{0,39}$/;

// How the dictation engine's state maps to items and back. The engine decides what syncs: every setting and key it
// reports is an item, so a new key or shared setting added to the engine syncs with no change here. Settings travel
// as JSON text so every platform compares the same bytes; keys travel raw here and are sealed by ItemSync.
function itemValuesFromEngine({ settings = {}, secrets = {} }) {
  const values = {};
  for (const [name, value] of Object.entries(settings)) values[`settings.${name}`] = value === undefined || value === null ? null : JSON.stringify(value);
  for (const [name, value] of Object.entries(secrets)) values[`secrets.${name}`] = value ?? null;
  for (const name of Object.keys(values)) if (!ITEM_NAME.test(name)) delete values[name];
  return values;
}
// Splits remote changes into the engine's apply request and the names that cannot be applied at all
// (a deleted setting has nothing to fall back to, and malformed JSON is ignored rather than guessed at).
function engineChangesFromItems(changes) {
  const payload = { settings: {}, secrets: {} }, refused = [];
  for (const [name, value] of Object.entries(changes)) {
    const [kind, key] = name.split('.');
    if (kind === 'secrets') payload.secrets[key] = value;
    else if (value === null) refused.push(name);
    else { try { payload.settings[key] = JSON.parse(value); } catch { refused.push(name); } }
  }
  return { payload, refused };
}

// Keeps settings and API keys in step with the account, within what this device was granted. Keys are sealed with
// the account's secrets key before they leave the device, so the server only ever stores ciphertext. Items this
// device does not know (a key only a newer app uses) are left untouched on the server.
class ItemSync {
  constructor({ file, crypto, account, local, onStatus = () => {}, now = Date.now }) {
    Object.assign(this, { file, crypto, account, local, onStatus, now });
    this.state = { base: {} };
    this.queue = Promise.resolve(); this.running = null; this.lastMessage = '';
  }
  status() { return { message: this.lastMessage }; }
  say(message) { this.lastMessage = message; const status = this.status(); this.onStatus(status); return status; }
  async load() {
    try { this.state = { base: JSON.parse(this.crypto.decryptString(await fs.readFile(this.file))).base ?? {} }; }
    catch { /* A missing or unreadable file means a fresh start; the next sync treats the account as the source of truth. */ }
  }
  async persist() {
    await fs.writeFile(this.file + '.tmp', this.crypto.encryptString(JSON.stringify(this.state)));
    await fs.rename(this.file + '.tmp', this.file);
  }
  enqueue(work) { const next = this.queue.then(work); this.queue = next.catch(() => {}); return next; }
  // Called when this device joins or leaves an account.
  forget() {
    return this.enqueue(async () => { this.state = { base: {} }; this.lastMessage = ''; await this.persist(); this.onStatus(this.status()); });
  }

  sync() {
    if (this.running) return this.running;
    this.running = this.enqueue(() => this.syncInternal()).finally(() => { this.running = null; });
    return this.running;
  }
  async syncInternal() {
    if (!this.account.session()) return this.status();
    try {
      const pulled = await this.account.request('/sync/items', { items: [] });
      await this.account.noteGrants(pulled.grants);
      const grants = pulled.grants ?? {};
      const key = this.account.keyFor('secrets');
      const remote = new Map(pulled.items.map(item => [item.name, item]));
      const localValues = await this.local.read();
      const now = this.now();
      const pushes = [], pulls = {}, nextBase = { ...this.state.base }, pending = {}, problems = [];
      const tracked = Object.keys(localValues).filter(name => isSecret(name) ? grants.secrets && key : grants.settings);
      for (const name of tracked) {
        const localValue = localValues[name] ?? null;
        const item = remote.get(name);
        let remoteValue = null, remoteState;
        if (item) {
          if (!item.deleted) {
            try { remoteValue = isSecret(name) ? vault.open(key, name, item.value) : item.value; }
            catch { problems.push(name); continue; }
          }
          remoteState = { digest: item.deleted ? null : vault.digest(name, remoteValue), updatedAt: item.updatedAt };
        }
        const decision = vault.reconcile(vault.digest(name, localValue), remoteState, this.state.base[name], now);
        if (decision.push) pushes.push({ name, value: localValue, updatedAt: decision.push.updatedAt });
        else if (decision.pull) { pulls[name] = remoteValue; pending[name] = decision.base; }
        else if (decision.base) nextBase[name] = decision.base; else delete nextBase[name];
      }
      if (Object.keys(pulls).length) {
        const refused = new Set(await this.local.write(pulls));
        for (const name of Object.keys(pulls)) if (!refused.has(name)) nextBase[name] = pending[name];
      }
      if (pushes.length) {
        const confirmed = await this.account.request('/sync/items', { items: pushes.map(push => push.value === null
          ? { name: push.name, value: '', deleted: true, updatedAt: push.updatedAt }
          : { name: push.name, value: isSecret(push.name) ? vault.seal(key, push.name, push.value) : push.value, deleted: false, updatedAt: push.updatedAt }) });
        const stored = new Map(confirmed.items.map(item => [item.name, item]));
        for (const push of pushes) if (stored.get(push.name)?.updatedAt === push.updatedAt && !confirmed.rejected?.includes(push.name))
          nextBase[push.name] = { digest: vault.digest(push.name, push.value), updatedAt: push.updatedAt };
      }
      this.state.base = nextBase; await this.persist();
      return this.say(problems.length ? `Synced. Could not read ${problems.join(', ')}.` : 'Synced');
    } catch (error) {
      if (error instanceof SignedOutError) return this.say('');
      return this.say(`${error.message}. Will retry.`);
    }
  }
}
module.exports = { ItemSync, itemValuesFromEngine, engineChangesFromItems };
