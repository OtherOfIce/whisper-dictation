const fs = require('node:fs/promises');

function normalize(terms) {
  if (!Array.isArray(terms) || terms.some(term => typeof term !== 'string' || /[\r\n]/.test(term))) throw new Error('Invalid dictionary response.');
  const result = [...new Map(terms.map(term => term.trim()).filter(Boolean).map(term => [term.toLowerCase(), term])).values()];
  if (result.length > 1000 || result.some(term => term.length > 120) || result.join('\n').length > 12000) throw new Error('Dictionary exceeds the app limits.');
  return result;
}
function changes(base, current) {
  const before = new Map(normalize(base).map(term => [term.toLowerCase(), term]));
  const after = new Map(normalize(current).map(term => [term.toLowerCase(), term]));
  return { add: [...after].filter(([key, term]) => before.get(key) !== term).map(([, term]) => term), remove: [...before.keys()].filter(key => !after.has(key)) };
}
function applyChanges(terms, delta) {
  const map = new Map(normalize(terms).map(term => [term.toLowerCase(), term]));
  for (const key of delta.remove) map.delete(key);
  for (const term of delta.add) map.set(term.toLowerCase(), term);
  return normalize([...map.values()]);
}
function validateConnection(url, key) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.port || !/^[a-z0-9-]+\.convex\.site$/.test(parsed.hostname) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('Enter your https://deployment.convex.site URL.');
  if (typeof key !== 'string' || key.length < 32 || key.length > 256 || !/^[A-Za-z0-9_-]+$/.test(key)) throw new Error('Use a sync key of 32–256 letters, numbers, underscores or hyphens.');
  return parsed.origin;
}

class DictionarySync {
  constructor({ file, crypto, readTerms, writeTerms, onStatus, fetchImpl = fetch }) {
    Object.assign(this, { file, crypto, readTerms, writeTerms, onStatus, fetchImpl });
    this.state = { url: '', key: '', base: [] }; this.queue = Promise.resolve(); this.running = null;
  }
  status(message) {
    if (message !== undefined) this.lastMessage = message;
    return { url: this.state.url, connected: !!this.state.key, message: this.lastMessage || (this.state.url ? 'Waiting to sync' : 'Sync is off') };
  }
  async load() {
    try {
      this.state = JSON.parse(this.crypto.decryptString(await fs.readFile(this.file)));
      if (this.state.url || this.state.key) validateConnection(this.state.url, this.state.key);
      normalize(this.state.base);
    }
    catch (error) { if (error.code !== 'ENOENT') { this.loadFailed = true; this.onStatus(this.status('Could not read sync settings')); } }
  }
  async persist() {
    const bytes = this.crypto.encryptString(JSON.stringify(this.state));
    await fs.writeFile(this.file + '.tmp', bytes); await fs.rename(this.file + '.tmp', this.file);
  }
  configure(url, key) {
    return this.enqueue(async () => {
      const nextKey = key || this.state.key;
      const origin = url ? validateConnection(url, nextKey) : '';
      const previous = this.state;
      this.state = { url: origin, key: origin ? nextKey : '', base: origin === previous.url && nextKey === previous.key ? previous.base : [] };
      try { await this.persist(); this.loadFailed = false; } catch (error) { this.state = previous; throw error; }
      this.onStatus(this.status(origin ? 'Waiting to sync' : 'Sync is off')); return this.status();
    });
  }
  enqueue(work) { const next = this.queue.then(work); this.queue = next.catch(() => {}); return next; }
  sync() {
    if (this.running) return this.running;
    this.running = this.enqueue(async () => {
      if (!this.state.key || this.loadFailed) return this.status();
      this.onStatus(this.status('Syncing…'));
      try {
        const snapshot = normalize(this.readTerms());
        const response = await this.fetchImpl(this.state.url + '/dictionary/sync', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.state.key}` },
          body: JSON.stringify(changes(this.state.base, snapshot)), signal: AbortSignal.timeout(15000), redirect: 'error'
        });
        if (!response.ok) throw new Error(response.status === 401 ? 'Sync key was rejected' : 'Dictionary sync failed');
        const remote = normalize((await response.json()).terms);
        const merged = applyChanges(remote, changes(snapshot, this.readTerms()));
        if (JSON.stringify(merged) !== JSON.stringify(normalize(this.readTerms()))) await this.writeTerms(merged);
        this.state.base = remote; await this.persist();
        const status = this.status('Synced'); this.onStatus(status); return status;
      } catch (error) {
        const status = this.status(`${error.message}. Local terms are saved; sync will retry.`); this.onStatus(status); return status;
      }
    }).finally(() => { this.running = null; });
    return this.running;
  }
}
module.exports = { DictionarySync, normalize, changes, applyChanges, validateConnection };
