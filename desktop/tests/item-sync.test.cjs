const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Account } = require('../account.cjs');
const { DictionarySync } = require('../dictionary-sync.cjs');
const { ItemSync, itemValuesFromEngine, engineChangesFromItems } = require('../item-sync.cjs');

// Every test runs the real server code (sync/convex) on an in-memory database.
const serverModule = import(path.join(__dirname, '../../sync/tests/fakeServer.js').replace(/\\/g, '/').replace(/^([A-Z]):/, 'file:///$1:'));
const passphrase = 'correct horse battery staple';
const plain = { encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() };

// One Windows install: its engine state, dictionary and the three sync objects, as main.cjs wires them.
async function device(t, server, name, engine = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'account-sync-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const local = {
    settings: { transcriptionModel: 'mai-transcribe-2-clean', cleanupMode: 'off', raceMai: true, ...engine.settings },
    secrets: { openrouter: null, xai: null, gateway: null, ...engine.secrets },
    terms: engine.terms ?? []
  };
  const account = new Account({ file: path.join(directory, 'account.bin'), crypto: plain, fetchImpl: server.fetch, hostname: () => name });
  const dictionary = new DictionarySync({ file: path.join(directory, 'dictionary.bin'), crypto: plain, account, readTerms: () => local.terms, writeTerms: async terms => { local.terms = terms; }, onStatus: () => {}, fetchImpl: server.fetch });
  const items = new ItemSync({
    file: path.join(directory, 'items.bin'), crypto: plain, account,
    local: {
      read: async () => itemValuesFromEngine(local),
      // Like the engine: names it does not know are refused, so they are tried again later.
      write: async changes => {
        const { payload, refused } = engineChangesFromItems(changes);
        for (const [key, value] of Object.entries(payload.settings)) if (key in local.settings) local.settings[key] = value; else refused.push(`settings.${key}`);
        for (const [key, value] of Object.entries(payload.secrets)) if (key in local.secrets) local.secrets[key] = value; else refused.push(`secrets.${key}`);
        return refused;
      }
    }
  });
  const sync = async () => { await items.sync(); await dictionary.sync(); };
  const joined = async () => { await items.forget(); await dictionary.resetAccount(); await sync(); };
  return { local, account, dictionary, items, sync, joined };
}
const storedValues = server => [...(server.tables.syncItems?.values() ?? [])].map(row => row.value).join('\n');

test('the first desktop creates the account and its keys reach paired devices sealed', async t => {
  const server = (await serverModule).fakeServer();
  const desk = await device(t, server, 'Desk', { settings: { transcriptionModel: 'gpt-transcribe', cleanupMode: 'luna' }, secrets: { openrouter: 'sk-or-desk', gateway: 'gw-desk' }, terms: ['Astra'] });
  await assert.rejects(desk.account.createAccount(server.origin, 'me@x.co', 'too short'), /12 characters/);
  await desk.account.createAccount(server.origin, ' Me@X.co ', passphrase);
  assert.deepEqual([desk.account.status().username, desk.account.status().admin], ['me@x.co', true]);
  await desk.joined();
  assert.equal(desk.items.status().message, 'Synced');
  assert.ok(!storedValues(server).includes('sk-or-desk') && !storedValues(server).includes('gw-desk'), 'the server only stores ciphertext');
  assert.ok(storedValues(server).includes('"gpt-transcribe"'));

  // A personal laptop gets everything; a work laptop gets keys and its own dictionary, but not settings.
  const personal = await device(t, server, 'Laptop');
  const work = await device(t, server, 'Work PC', { settings: { cleanupMode: 'luna-fast' }, terms: ['Kubernetes'] });
  const personalCode = await desk.account.addDevice({ name: 'Laptop', grants: { secrets: true, settings: true, history: false, dictionary: 'Personal' } });
  const workCode = await desk.account.addDevice({ name: 'Work laptop', grants: { secrets: true, settings: false, history: false, dictionary: 'Work' } });
  await personal.account.pair(server.origin, personalCode.code.toLowerCase().replace(/-/g, ' '));
  await work.account.pair(server.origin, workCode.code);
  await assert.rejects(work.account.pair(server.origin, workCode.code), /did not work/, 'a code works once');
  await personal.joined(); await work.joined();

  assert.deepEqual(personal.local.secrets, { openrouter: 'sk-or-desk', xai: null, gateway: 'gw-desk' });
  assert.deepEqual(personal.local.settings, desk.local.settings);
  assert.deepEqual(personal.local.terms, ['Astra']);
  assert.deepEqual(work.local.secrets.openrouter, 'sk-or-desk');
  assert.equal(work.local.settings.cleanupMode, 'luna-fast', 'settings were not granted, so they stay as they were');
  assert.deepEqual(work.local.terms, ['Kubernetes'], 'the work dictionary is separate');
  assert.equal(work.account.status().name, 'Work laptop');

  // A new key on the work laptop reaches the others; a cleared one is cleared everywhere it is granted.
  work.local.secrets.xai = 'xai-work'; await work.sync(); await desk.sync(); await personal.sync();
  assert.equal(desk.local.secrets.xai, 'xai-work');
  assert.equal(personal.local.secrets.xai, 'xai-work');
  desk.local.secrets.gateway = null; await desk.sync(); await work.sync();
  assert.equal(work.local.secrets.gateway, null);
});

test('a device paired without API keys never receives the key that opens them', async t => {
  const server = (await serverModule).fakeServer();
  const desk = await device(t, server, 'Desk', { secrets: { openrouter: 'sk-or-desk' } });
  await desk.account.createAccount(server.origin, 'me@x.co', passphrase); await desk.joined();
  const kiosk = await device(t, server, 'Kiosk', { secrets: { openrouter: 'sk-kiosk-own' } });
  await kiosk.account.pair(server.origin, (await desk.account.addDevice({ name: 'Kiosk', grants: { secrets: false, settings: true, history: false, dictionary: null } })).code);
  await kiosk.joined();
  assert.equal(kiosk.account.keyFor('secrets'), null);
  assert.equal(kiosk.local.secrets.openrouter, 'sk-kiosk-own', 'its own key is neither replaced nor uploaded');
  assert.equal(kiosk.dictionary.status().message, 'Dictionary sync is off for this device');
  const listed = await desk.account.listDevices();
  const entry = listed.devices.find(item => item.name === 'Kiosk');
  await assert.rejects(desk.account.updateDevice(entry.id, { grants: { secrets: true, settings: true, history: false, dictionary: null } }), /pair it again/);
});

test('keys only a newer app uses are kept on the server until this device learns them', async t => {
  const server = (await serverModule).fakeServer();
  const desk = await device(t, server, 'Desk', { secrets: { openrouter: 'sk-1', futureProvider: 'fp-1' } });
  await desk.account.createAccount(server.origin, 'me@x.co', passphrase); await desk.joined();
  const old = await device(t, server, 'Old laptop', { secrets: { openrouter: 'sk-1' } });
  await old.account.pair(server.origin, (await desk.account.addDevice({ name: 'Old laptop', grants: { secrets: true, settings: true, history: false, dictionary: 'Personal' } })).code);
  await old.joined();
  assert.equal('futureProvider' in old.local.secrets, false);
  assert.ok([...server.tables.syncItems.values()].some(row => row.name === 'secrets.futureProvider' && !row.deleted), 'not deleted by a device that does not know it');
  old.local.secrets.futureProvider = null; // the app update adds the provider, with no key saved yet
  await old.sync();
  assert.equal(old.local.secrets.futureProvider, 'fp-1');
});

test('grant changes and removals made on the desktop reach the device', async t => {
  const server = (await serverModule).fakeServer();
  const desk = await device(t, server, 'Desk', { settings: { cleanupMode: 'luna' }, terms: ['Astra'] });
  await desk.account.createAccount(server.origin, 'me@x.co', passphrase); await desk.joined();
  const work = await device(t, server, 'Work PC', { terms: ['Kubernetes'] });
  await work.account.pair(server.origin, (await desk.account.addDevice({ name: 'Work', grants: { secrets: true, settings: false, history: false, dictionary: 'Work' } })).code);
  await work.joined();
  const id = (await desk.account.listDevices()).devices.find(item => item.name === 'Work').id;

  await desk.account.updateDevice(id, { grants: { secrets: true, settings: true, history: false, dictionary: 'Personal' } });
  await work.sync();
  assert.equal(work.local.settings.cleanupMode, 'luna', 'settings follow once granted');
  assert.deepEqual(work.local.terms, ['Astra'], 'moving to another list replaces the local terms with it');
  await work.sync(); await desk.sync();
  assert.deepEqual(desk.local.terms, ['Astra'], 'and does not copy the old list into the new one');

  await desk.account.removeDevice(id);
  await work.sync();
  assert.equal(work.account.status().signedIn, false);
  assert.match(work.account.status().message, /signed out/);
});

test('another desktop signs in with the passphrase, and changing it signs that desktop out', async t => {
  const server = (await serverModule).fakeServer();
  const desk = await device(t, server, 'Desk', { secrets: { openrouter: 'sk-desk' } });
  await desk.account.createAccount(server.origin, 'me@x.co', passphrase); await desk.joined();
  await assert.rejects((await device(t, server, 'Copy')).account.createAccount(server.origin, 'me@x.co', passphrase), /already has an account/);
  const laptop = await device(t, server, 'Laptop');
  await assert.rejects(laptop.account.signIn(server.origin, 'me@x.co', 'not the passphrase'), /do not match/);
  await laptop.account.signIn(server.origin, 'me@x.co', ` ${passphrase} `);
  await laptop.joined();
  assert.equal(laptop.local.secrets.openrouter, 'sk-desk');
  assert.equal(laptop.account.status().admin, true);

  await desk.account.changePassphrase('a different long passphrase');
  await laptop.sync();
  assert.equal(laptop.account.status().signedIn, false);
  await assert.rejects(laptop.account.signIn(server.origin, 'me@x.co', passphrase), /do not match/);
  await laptop.account.signIn(server.origin, 'me@x.co', 'a different long passphrase');
  assert.deepEqual(laptop.account.keyFor('secrets'), desk.account.keyFor('secrets'), 'the same keys, wrapped again');
});

test('signing out keeps local values and the next account starts fresh', async t => {
  const server = (await serverModule).fakeServer();
  const desk = await device(t, server, 'Desk', { secrets: { openrouter: 'sk-desk' } });
  await desk.account.createAccount(server.origin, 'me@x.co', passphrase); await desk.joined();
  await desk.account.signOut();
  assert.deepEqual([desk.account.status().signedIn, desk.account.status().message], [false, 'Signed out']);
  assert.equal(desk.local.secrets.openrouter, 'sk-desk');
  const reloaded = new Account({ file: desk.account.file, crypto: plain, fetchImpl: server.fetch });
  await reloaded.load();
  assert.equal(reloaded.status().signedIn, false);
});

test('engine state maps to items and back', () => {
  assert.deepEqual(itemValuesFromEngine({ settings: { cleanupMode: 'luna', raceMai: false, 'bad name': 1 }, secrets: { openrouter: 'k', xai: null } }),
    { 'settings.cleanupMode': '"luna"', 'settings.raceMai': 'false', 'secrets.openrouter': 'k', 'secrets.xai': null });
  assert.deepEqual(engineChangesFromItems({ 'settings.cleanupMode': '"off"', 'settings.raceMai': null, 'settings.x': '{bad', 'secrets.xai': null }),
    { payload: { settings: { cleanupMode: 'off' }, secrets: { xai: null } }, refused: ['settings.raceMai', 'settings.x'] });
});
