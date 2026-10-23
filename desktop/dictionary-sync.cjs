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
function validateUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Enter your https://deployment.convex.site URL.'); }
  if (parsed.protocol !== 'https:' || parsed.port || !/^[a-z0-9-]+\.convex\.site$/.test(parsed.hostname) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('Enter your https://deployment.convex.site URL.');
  return parsed.origin;
}
function validateConnection(url, key) {
  const origin = validateUrl(url);
  if (typeof key !== 'string' || key.length < 32 || key.length > 256 || !/^[A-Za-z0-9_-]+$/.test(key)) throw new Error('Use a sync key of 32–256 letters, numbers, underscores or hyphens.');
  return origin;
}

// Syncs the dictionary. Signed in, it syncs the one list the account gives this device; otherwise it can still use
// the older shared key. The account itself (token, grants) lives in account.cjs.
class DictionarySync {
  constructor({ file, crypto, account, readTerms, writeTerms, onStatus, fetchImpl = fetch }) {
    Object.assign(this, { file, crypto, account, readTerms, writeTerms, onStatus, fetchImpl });
    this.state = { url: '', key: '', base: [], list: null }; this.queue = Promise.resolve(); this.running = null;
  }
  status(message) {
    if (message !== undefined) this.lastMessage = message;
    const signedIn = !!this.account?.session();
    const { url, key } = this.state;
    return { url, sharedKey: !signedIn && !!key, list: signedIn ? this.state.list : null, message: this.lastMessage || (signedIn || url ? 'Waiting to sync' : 'Sync is off') };
  }
  async load() {
    try {
      this.state = { url: '', key: '', base: [], list: null, ...JSON.parse(this.crypto.decryptString(await fs.readFile(this.file))) };
      delete this.state.token; delete this.state.email; // from the email sign-in this replaced
      if (this.state.key) validateConnection(this.state.url, this.state.key);
      normalize(this.state.base);
    }
    catch (error) { if (error.code !== 'ENOENT') { this.loadFailed = true; this.onStatus(this.status('Could not read sync settings')); } }
  }
  async persist() {
    const bytes = this.crypto.encryptString(JSON.stringify(this.state));
    await fs.writeFile(this.file + '.tmp', bytes); await fs.rename(this.file + '.tmp', this.file);
  }
  // Called when this device joins or leaves an account: the next sync starts from no shared history, so local terms
  // are merged into the account's list rather than treated as deletions.
  resetAccount() {
    return this.enqueue(async () => {
      this.state = { ...this.state, base: [], list: null }; this.lastMessage = '';
      await this.persist(); this.loadFailed = false; this.onStatus(this.status());
    });
  }
  configure(url, key) {
    return this.enqueue(async () => {
      if (this.account?.session()) throw new Error('Sign out before using a shared sync key.');
      const nextKey = key || this.state.key;
      const origin = url ? validateConnection(url, nextKey) : '';
      const previous = this.state;
      this.state = { url: origin, key: origin ? nextKey : '', base: origin === previous.url && nextKey === previous.key ? previous.base : [], list: null };
      try { await this.persist(); this.loadFailed = false; } catch (error) { this.state = previous; throw error; }
      this.onStatus(this.status(origin ? 'Waiting to sync' : 'Sync is off')); return this.status();
    });
  }
  enqueue(work) { const next = this.queue.then(work); this.queue = next.catch(() => {}); return next; }
  sync() {
    if (this.running) return this.running;
    this.running = this.enqueue(async () => {
      const session = this.account?.session();
      if (this.loadFailed || (!session && !this.state.key)) return this.status();
      const list = session ? this.account.status().grants?.dictionary ?? null : null;
      if (session && !list) return this.status('Dictionary sync is off for this device');
      this.onStatus(this.status('Syncing…'));
      try {
        const snapshot = normalize(this.readTerms());
        // Moving to a different list replaces the local terms with that list; the old list stays on the server.
        if (session && this.state.list && this.state.list !== list) this.state.base = snapshot;
        const response = await this.fetchImpl((session?.url ?? this.state.url) + '/dictionary/sync', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.token ?? this.state.key}` },
          body: JSON.stringify(changes(this.state.base, snapshot)), signal: AbortSignal.timeout(15000), redirect: 'error'
        });
        if (response.status === 401 && session) { await this.account.dropped(); this.state.base = []; this.state.list = null; await this.persist(); return this.status(''); }
        if (!response.ok) throw new Error(response.status === 401 ? 'Sync key was rejected' : 'Dictionary sync failed');
        const reply = await response.json();
        if (reply.off) return this.status('Dictionary sync is off for this device');
        const remote = normalize(reply.terms);
        const merged = applyChanges(remote, changes(snapshot, this.readTerms()));
        if (JSON.stringify(merged) !== JSON.stringify(normalize(this.readTerms()))) await this.writeTerms(merged);
        this.state.base = remote; this.state.list = session ? reply.list ?? list : null; await this.persist();
        const status = this.status('Synced'); this.onStatus(status); return status;
      } catch (error) {
        const status = this.status(`${error.message}. Local terms are saved; sync will retry.`); this.onStatus(status); return status;
      }
    }).finally(() => { this.running = null; });
    return this.running;
  }
}
module.exports = { DictionarySync, normalize, changes, applyChanges, validateConnection, validateUrl };
