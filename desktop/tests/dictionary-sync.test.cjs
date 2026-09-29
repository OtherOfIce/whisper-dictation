const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DictionarySync, changes, applyChanges, validateConnection } = require('../dictionary-sync.cjs');

test('merges independent offline edits and propagates deletions and spelling changes', () => {
  const base = ['Astra', 'Old'];
  const desktop = changes(base, ['ASTRA', 'Desktop']);
  const phone = changes(base, ['Astra', 'Old', 'Phone']);
  const server = applyChanges(applyChanges(base, desktop), phone);
  assert.deepEqual(server, ['ASTRA', 'Desktop', 'Phone']);
  assert.deepEqual(applyChanges(server, changes(base, base)), server);
});

test('requires HTTPS Convex site URL and a strong shared key', () => {
  const key = 'a'.repeat(32);
  assert.equal(validateConnection('https://test-123.convex.site', key), 'https://test-123.convex.site');
  for (const url of ['http://test.convex.site', 'https://example.com', 'https://test.convex.site/path', 'https://user@test.convex.site']) assert.throws(() => validateConnection(url, key));
  assert.throws(() => validateConnection('https://test.convex.site', 'short'));
});

test('retains offline changes, merges edits during a request, and resumes after restart', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dictionary-sync-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let terms = ['Desktop'], server = ['Phone'], offline = true, editDuringRequest = true, requests = [];
  const options = {
    file: path.join(directory, 'state.bin'), crypto: { encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() },
    readTerms: () => terms, writeTerms: async value => { terms = value; }, onStatus: () => {},
    fetchImpl: async (url, options) => {
      if (offline) throw new Error('Offline');
      const delta = JSON.parse(options.body); requests.push(delta);
      server = applyChanges(server, delta);
      if (editDuringRequest) { terms.push('New edit'); editDuringRequest = false; }
      return { ok: true, json: async () => ({ terms: server }) };
    }
  };
  const sync = new DictionarySync(options);
  await sync.configure('https://test.convex.site', 'a'.repeat(32));
  assert.match((await sync.sync()).message, /retry/);
  assert.deepEqual(terms, ['Desktop']);
  offline = false; await sync.sync();
  assert.deepEqual(terms, ['Phone', 'Desktop', 'New edit']);
  const restarted = new DictionarySync(options); await restarted.load(); await restarted.sync();
  assert.deepEqual(requests[1], { add: ['New edit'], remove: [] });
  terms = terms.filter(term => term !== 'Phone'); await restarted.sync();
  assert.deepEqual(server, ['Desktop', 'New edit']);
  await restarted.configure('', ''); await restarted.sync();
  assert.equal(restarted.status().connected, false);
  assert.deepEqual(terms, ['Desktop', 'New edit']);
  const disconnected = new DictionarySync(options); await disconnected.load();
  assert.equal(disconnected.loadFailed, undefined);
  assert.equal(disconnected.status().message, 'Sync is off');
});

test('does not acknowledge remote terms when the local engine rejects the update', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dictionary-sync-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sync = new DictionarySync({
    file: path.join(directory, 'state.bin'), crypto: { encryptString: text => Buffer.from(text) },
    readTerms: () => [], writeTerms: async () => { throw new Error('Recording'); }, onStatus: () => {},
    fetchImpl: async () => ({ ok: true, json: async () => ({ terms: ['Phone'] }) })
  });
  await sync.configure('https://test.convex.site', 'a'.repeat(32));
  await sync.sync(); assert.deepEqual(sync.state.base, []);
});
