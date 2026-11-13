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

// Accounts made before linked devices: an email and passphrase, created by older desktops.
async function legacyAccount(account, origin, email) {
  const vault = require('../vault.cjs');
  const { authKey, wrapKey } = await vault.deriveAccount(email, passphrase);
  const response = await account.fetchImpl(origin + '/account/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: email, authKey, keyring: vault.sealKeyring(wrapKey, vault.newKeyring()), deviceName: 'Old desk' }) });
  assert.equal(response.status, 200);
}

test('turning sync on links devices as equals, and keys only travel sealed', async t => {
  const server = (await serverModule).fakeServer();
  const desk = await device(t, server, 'Desk', { settings: { transcriptionModel: 'gpt-transcribe', cleanupMode: 'luna' }, secrets: { openrouter: 'sk-or-desk', gateway: 'gw-desk' }, terms: ['Astra'] });
  const recoveryKey = await desk.account.turnOn(server.origin);
  assert.match(recoveryKey, /^([0-9A-Z]{5}-){5}[0-9A-Z]{5}$/);
  assert.deepEqual([desk.account.status().kind, desk.account.status().canManage, desk.account.status().hasRecoveryKey], ['linked', true, true]);
  await desk.joined();
  assert.equal(desk.items.status().message, 'Synced');
  assert.ok(!storedValues(server).includes('sk-or-desk') && !storedValues(server).includes('gw-desk'), 'the server only stores ciphertext');

  const laptop = await device(t, server, 'Laptop');
  const { code } = await desk.account.linkDevice('Laptop');
  await laptop.account.pair(server.origin, code.toLowerCase().replace(/-/g, ' '));
  await assert.rejects((await device(t, server, 'Again')).account.pair(server.origin, code), /did not work/, 'a code works once');
  await laptop.joined();
  assert.deepEqual(laptop.local.secrets, { openrouter: 'sk-or-desk', xai: null, gateway: 'gw-desk' });
  assert.deepEqual(laptop.local.settings, desk.local.settings);
  assert.deepEqual(laptop.local.terms, ['Astra']);

  // The laptop is a peer: it can link a phone and remove devices, and changes flow every way.
  assert.equal(laptop.account.status().canManage, true);
  const phone = await device(t, server, 'Phone');
  await phone.account.pair(server.origin, (await laptop.account.linkDevice('Phone')).code);
  await phone.joined();
  assert.equal(phone.local.secrets.openrouter, 'sk-or-desk');
  phone.local.secrets.xai = 'xai-phone'; await phone.sync(); await desk.sync();
  assert.equal(desk.local.secrets.xai, 'xai-phone');
  desk.local.secrets.gateway = null; await desk.sync(); await laptop.sync();
  assert.equal(laptop.local.secrets.gateway, null);

  const phoneId = (await laptop.account.listDevices()).devices.find(item => item.name === 'Phone').id;
  await laptop.account.removeDevice(phoneId);
  await phone.sync();
  assert.equal(phone.account.status().signedIn, false);
  assert.match(phone.account.status().message, /removed from sync/);
  assert.equal(phone.local.secrets.openrouter, 'sk-or-desk', 'a removed device keeps what it had');
});

test('the recovery key brings an account back, and a new one replaces it without signing devices out', async t => {
  const server = (await serverModule).fakeServer();
  const desk = await device(t, server, 'Desk', { secrets: { openrouter: 'sk-desk' }, terms: ['Raikage'] });
  const recoveryKey = await desk.account.turnOn(server.origin); await desk.joined();
  const fresh = await device(t, server, 'New PC');
  await assert.rejects(fresh.account.recover(server.origin, 'nope'), /30-character/);
  await fresh.account.recover(server.origin, recoveryKey.toLowerCase());
  await fresh.joined();
  assert.equal(fresh.local.secrets.openrouter, 'sk-desk');
  assert.deepEqual(fresh.local.terms, ['Raikage']);
  assert.equal(fresh.account.recoveryKey(), recoveryKey);

  const replaced = await desk.account.newRecoveryKey();
  assert.notEqual(replaced, recoveryKey);
  assert.equal(replaced.slice(0, 11), recoveryKey.slice(0, 11), 'same account');
  await fresh.sync();
  assert.equal(fresh.account.status().signedIn, true, 'linked devices stay signed in');
  await assert.rejects((await device(t, server, 'Thief')).account.recover(server.origin, recoveryKey), /do not match/);
  const again = await device(t, server, 'Again');
  await again.account.recover(server.origin, replaced);
  assert.deepEqual(again.account.keyFor('secrets'), desk.account.keyFor('secrets'), 'the same keys, wrapped again');
});

test('accounts made with an email and passphrase still sign in', async t => {
  const server = (await serverModule).fakeServer();
  const old = await device(t, server, 'Old desk');
  await legacyAccount(old.account, server.origin, 'me@x.co');
  const laptop = await device(t, server, 'Laptop', { secrets: { openrouter: 'sk-laptop' } });
  await assert.rejects(laptop.account.signIn(server.origin, 'me@x.co', 'not the passphrase'), /do not match/);
  await laptop.account.signIn(server.origin, 'Me@X.co', ` ${passphrase} `);
  await laptop.joined();
  assert.deepEqual([laptop.account.status().kind, laptop.account.status().username, laptop.account.status().canManage], ['legacy', 'me@x.co', true]);
  await assert.rejects(laptop.account.newRecoveryKey(), /does not have the current recovery key/);
  const phone = await device(t, server, 'Phone');
  await phone.account.pair(server.origin, (await laptop.account.linkDevice()).code);
  await phone.joined();
  assert.equal(phone.local.secrets.openrouter, 'sk-laptop');
});

test('keys only a newer app uses are kept on the server until this device learns them', async t => {
  const server = (await serverModule).fakeServer();
  const desk = await device(t, server, 'Desk', { secrets: { openrouter: 'sk-1', futureProvider: 'fp-1' } });
  await desk.account.turnOn(server.origin); await desk.joined();
  const old = await device(t, server, 'Old laptop', { secrets: { openrouter: 'sk-1' } });
  await old.account.pair(server.origin, (await desk.account.linkDevice('Old laptop')).code);
  await old.joined();
  assert.equal('futureProvider' in old.local.secrets, false);
  assert.ok([...server.tables.syncItems.values()].some(row => row.name === 'secrets.futureProvider' && !row.deleted), 'not deleted by a device that does not know it');
  old.local.secrets.futureProvider = null; // the app update adds the provider, with no key saved yet
  await old.sync();
  assert.equal(old.local.secrets.futureProvider, 'fp-1');
});

test('turning sync off keeps local values and the next account starts fresh', async t => {
  const server = (await serverModule).fakeServer();
  const desk = await device(t, server, 'Desk', { secrets: { openrouter: 'sk-desk' } });
  await desk.account.turnOn(server.origin); await desk.joined();
  await desk.account.signOut();
  assert.deepEqual([desk.account.status().signedIn, desk.account.status().message, desk.account.recoveryKey()], [false, 'Signed out', null]);
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
