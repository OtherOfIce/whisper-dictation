import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeServer } from './fakeServer.js';
import * as auth from '../convex/auth.js';
import crons from '../convex/crons.js';
import { TOKEN_PATTERN, generateToken, isEnvelope, mayCreate, normalizeEmail, sha256Hex, validateGrants } from '../convex/authCore.js';

const authKey = letter => letter.repeat(43) + '=';
const envelope = (tag = 'A') => `v1.${'B'.repeat(16)}.${tag.repeat(40)}`;
const pairId = digit => digit.repeat(64);

function withEnv(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) value === undefined ? delete process.env[name] : process.env[name] = value;
  const restore = () => { for (const [name, value] of Object.entries(previous)) value === undefined ? delete process.env[name] : process.env[name] = value; };
  return Promise.resolve().then(run).finally(restore);
}

// A client for the fake server: `call(path, body, token)` answers { status, body }.
function setup() {
  const server = fakeServer();
  const call = async (path, body = {}, token) => {
    const response = await server.fetch(server.origin + path, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const create = (username = 'me@x.co', key = authKey('a')) => call('/account/create', { username, authKey: key, keyring: envelope('K'), deviceName: 'Desk' });
  const pair = async (admin, grants, name = 'Phone', id = pairId('1')) => {
    assert.equal((await call('/devices/pair', { name, grants, pairId: id, payload: envelope('P') }, admin)).status, 200);
    return call('/pair/claim', { pairId: id });
  };
  return { server, call, create, pair };
}

test('username, grants and token helpers', async () => {
  assert.equal(normalizeEmail('  Liam@Example.COM '), 'liam@example.com');
  for (const bad of ['', 'nope', 'a@b', 'a b@c.com', 5, null]) assert.equal(normalizeEmail(bad), null);
  assert.equal(mayCreate('a@b.co', ''), true, 'open when no list is set');
  assert.equal(mayCreate('a@b.co', 'x@y.co, A@B.co'), true);
  assert.equal(mayCreate('a@b.co', 'x@y.co'), false);
  assert.deepEqual(validateGrants({ secrets: true, settings: false, history: true, dictionary: 'Work' }), { secrets: true, settings: false, history: false, dictionary: 'Work' }, 'history cannot be granted yet');
  assert.deepEqual(validateGrants({ secrets: false, settings: true }), { secrets: false, settings: true, history: false, dictionary: null });
  for (const bad of [null, {}, { secrets: 'yes', settings: true }, { secrets: true, settings: true, dictionary: '../x' }, { secrets: true, settings: true, dictionary: '' }]) assert.equal(validateGrants(bad), null);
  assert.equal(isEnvelope(envelope()), true);
  assert.equal(isEnvelope('v1.short.x'), false);
  assert.match(generateToken(), TOKEN_PATTERN);
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('the first desktop creates the account; signing in again needs the same passphrase', async () => {
  const { call, create, server } = setup();
  const created = await create(' Me@X.co ');
  assert.equal(created.status, 200);
  assert.match(created.body.token, TOKEN_PATTERN);
  assert.deepEqual([created.body.username, created.body.admin, created.body.grants.dictionary], ['me@x.co', true, 'Personal']);
  assert.equal((await create('me@x.co', authKey('z'))).status, 409, 'an account is created once');
  assert.equal(JSON.stringify([...server.tables.users.values()]).includes(authKey('a')), false, 'only a hash of the auth key is stored');

  assert.equal((await call('/account/sign-in', { username: 'me@x.co', authKey: authKey('b') })).status, 401);
  assert.equal((await call('/account/sign-in', { username: 'nobody@x.co', authKey: authKey('a') })).status, 401);
  const laptop = await call('/account/sign-in', { username: 'ME@x.co', authKey: authKey('a'), deviceName: 'Laptop' });
  assert.equal(laptop.status, 200);
  assert.equal(laptop.body.keyring, envelope('K'), 'the sealed keyring comes back to an admin device');
  assert.equal((await call('/account/me', {}, laptop.body.token)).body.name, 'Laptop');
  assert.equal((await call('/account/sign-in', { username: 'me@x.co' })).status, 400);
});

test('wrong passphrases are limited per username', async () => {
  const { call, create } = setup();
  await create();
  for (let attempt = 0; attempt < 10; attempt++) assert.equal((await call('/account/sign-in', { username: 'me@x.co', authKey: authKey('b') })).status, 401);
  assert.equal((await call('/account/sign-in', { username: 'me@x.co', authKey: authKey('a') })).status, 429, 'even the right one waits');
});

test('ALLOWED_EMAILS closes sign-up to the listed usernames', () => withEnv({ ALLOWED_EMAILS: 'me@x.co' }, async () => {
  const { create } = setup();
  assert.equal((await create('stranger@x.co')).status, 403);
  assert.equal((await create('me@x.co')).status, 200);
}));

test('a desktop pairs devices with a one-time code', async () => {
  const { call, create, pair } = setup();
  const admin = (await create()).body.token;
  const phone = await pair(admin, { secrets: true, settings: true, dictionary: 'Personal' });
  assert.equal(phone.status, 200);
  assert.deepEqual([phone.body.username, phone.body.name, phone.body.admin, phone.body.payload], ['me@x.co', 'Phone', false, envelope('P')]);
  assert.equal((await call('/pair/claim', { pairId: pairId('1') })).status, 404, 'a code works once');
  assert.equal((await call('/pair/claim', { pairId: pairId('9') })).status, 404);
  assert.equal((await call('/pair/claim', { pairId: 'short' })).status, 400);

  const listed = (await call('/devices/list', {}, admin)).body;
  assert.deepEqual(listed.devices.map(device => [device.name, device.admin, device.current]), [['Desk', true, true], ['Phone', false, false]]);
  assert.deepEqual(listed.lists, ['Personal']);
});

test('every linked device can list, pair and remove the others', async () => {
  const { call, create, pair } = setup();
  const desk = (await create()).body.token;
  const phone = (await pair(desk, { secrets: true, settings: true, dictionary: 'Personal' })).body.token;
  const me = (await call('/account/me', {}, phone)).body;
  assert.deepEqual([me.admin, me.version], [false, 2], 'the server says peers may manage devices');
  const listed = (await call('/devices/list', {}, phone)).body;
  assert.deepEqual(listed.devices.map(device => [device.name, device.current]), [['Desk', false], ['Phone', true]]);
  const laptop = await pair(phone, { secrets: true, settings: true, dictionary: 'Personal' }, 'Laptop', pairId('2'));
  assert.equal(laptop.status, 200, 'a paired device can link another');
  assert.equal(laptop.body.payload, envelope('P'));
  const [deskEntry, phoneEntry] = (await call('/devices/list', {}, laptop.body.token)).body.devices;
  assert.equal((await call('/devices/remove', { id: phoneEntry.id }, phone)).status, 400, 'not itself');
  assert.equal((await call('/devices/update', { id: deskEntry.id, name: 'Old desk', grants: { secrets: true, settings: true, dictionary: 'Personal' } }, phone)).status, 200);
  assert.equal((await call('/devices/remove', { id: deskEntry.id }, laptop.body.token)).status, 200);
  assert.equal((await call('/account/me', {}, desk)).status, 401, 'the removed desktop is signed out');
  assert.equal((await call('/sync/items', { items: [] }, phone)).body.version, 2);
});

test('pairing codes expire after 10 minutes', async () => {
  const { call, create, server } = setup();
  const admin = (await create()).body.token;
  await call('/devices/pair', { name: 'Late', grants: { secrets: false, settings: true, dictionary: null }, pairId: pairId('3'), payload: envelope() }, admin);
  for (const row of server.tables.pairings.values()) row.expiresAt = Date.now() - 1;
  assert.equal((await call('/pair/claim', { pairId: pairId('3') })).status, 404);
});

test('a device only syncs what it was granted', async () => {
  const { call, create, pair } = setup();
  const admin = (await create()).body.token;
  const work = (await pair(admin, { secrets: true, settings: false, dictionary: 'Work' }, 'Work laptop')).body.token;
  const kiosk = (await pair(admin, { secrets: false, settings: true, dictionary: null }, 'Kiosk', pairId('2'))).body.token;
  const now = Date.now();
  const item = (name, value) => ({ name, value, deleted: false, updatedAt: now });
  await call('/sync/items', { items: [item('settings.cleanupMode', '"luna"'), item('secrets.openrouter', envelope('S')), item('secrets.futureProvider', envelope('F'))] }, admin);

  const workView = (await call('/sync/items', { items: [item('settings.raceMai', 'true')] }, work)).body;
  assert.deepEqual(workView.items.map(entry => entry.name).sort(), ['secrets.futureProvider', 'secrets.openrouter'], 'any key syncs, but no settings');
  assert.deepEqual(workView.rejected, ['settings.raceMai']);
  const kioskView = (await call('/sync/items', { items: [item('secrets.openrouter', envelope('X'))] }, kiosk)).body;
  assert.deepEqual(kioskView.items.map(entry => entry.name), ['settings.cleanupMode']);
  assert.deepEqual(kioskView.rejected, ['secrets.openrouter']);
  assert.equal((await call('/sync/items', { items: [item('history.today', 'x')] }, admin)).body.rejected[0], 'history.today', 'history is not granted to anyone yet');
  assert.equal((await call('/sync/items', { items: [item('bad name', 'x')] }, admin)).status, 400);

  // Dictionary lists are separate, and a device without one gets nothing.
  const words = (token, add) => call('/dictionary/sync', { add, remove: [] }, token);
  assert.deepEqual((await words(admin, ['Astra'])).body, { terms: ['Astra'], list: 'Personal' });
  assert.deepEqual((await words(work, ['Kubernetes'])).body, { terms: ['Kubernetes'], list: 'Work' });
  assert.deepEqual((await words(kiosk, ['Leak'])).body, { off: true });
  assert.deepEqual((await words(admin, [])).body.terms, ['Astra']);
  assert.deepEqual((await call('/devices/list', {}, admin)).body.lists, ['Personal', 'Work']);
});

test('a device can change, and remove, what a device gets', async () => {
  const { call, create, pair } = setup();
  const admin = (await create()).body.token;
  const work = (await pair(admin, { secrets: false, settings: true, dictionary: 'Work' }, 'Work laptop')).body.token;
  const [, device] = (await call('/devices/list', {}, admin)).body.devices;
  assert.equal(device.hasKeys, false);
  const refused = await call('/devices/update', { id: device.id, grants: { secrets: true, settings: true, dictionary: 'Work' } }, admin);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /pair it again/);
  assert.equal((await call('/devices/update', { id: device.id, name: 'Old laptop', grants: { secrets: false, settings: false, dictionary: 'Personal' } }, admin)).status, 200);
  assert.deepEqual((await call('/account/me', {}, work)).body.grants, { secrets: false, settings: false, history: false, dictionary: 'Personal' });
  assert.equal((await call('/account/me', {}, work)).body.name, 'Old laptop');
  assert.equal((await call('/devices/remove', { id: (await call('/devices/list', {}, admin)).body.devices[0].id }, admin)).status, 400, 'not itself');
  assert.equal((await call('/devices/remove', { id: device.id }, admin)).status, 200);
  assert.equal((await call('/sync/items', { items: [] }, work)).status, 401, 'a removed device is signed out');
});

test('changing the passphrase needs the current one and keeps every device signed in', async () => {
  const { call, create, pair } = setup();
  const desk = (await create()).body.token;
  const laptop = (await call('/account/sign-in', { username: 'me@x.co', authKey: authKey('a') })).body.token;
  const phone = (await pair(desk, { secrets: true, settings: true, dictionary: 'Personal' })).body.token;
  const change = (current, token = desk) => call('/account/passphrase', { currentAuthKey: current, authKey: authKey('n'), keyring: envelope('N') }, token);
  assert.equal((await call('/account/passphrase', { authKey: authKey('n'), keyring: envelope('N') }, desk)).status, 400, 'the current key is required');
  const wrong = await change(authKey('b'));
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error, 'The current recovery key or passphrase is wrong.');
  assert.equal((await call('/account/sign-in', { username: 'me@x.co', authKey: authKey('a') })).status, 200, 'nothing changed');
  assert.equal((await change(authKey('a'), phone)).status, 200, 'any device that knows the current key can change it');
  for (const token of [desk, laptop, phone]) assert.equal((await call('/account/me', {}, token)).status, 200);
  assert.equal((await call('/account/sign-in', { username: 'me@x.co', authKey: authKey('a') })).status, 401);
  assert.equal((await call('/account/sign-in', { username: 'me@x.co', authKey: authKey('n') })).body.keyring, envelope('N'));
});

test('wrong current passphrases count against the hourly limit', async () => {
  const { call, create } = setup();
  const desk = (await create()).body.token;
  const change = current => call('/account/passphrase', { currentAuthKey: current, authKey: authKey('n'), keyring: envelope('N') }, desk);
  for (let attempt = 0; attempt < 10; attempt++) assert.equal((await change(authKey('b'))).status, 403);
  assert.equal((await change(authKey('a'))).status, 429, 'even the right one waits');
  assert.equal((await call('/account/sign-in', { username: 'me@x.co', authKey: authKey('a') })).status, 429, 'shared with sign-in');
});

test('the hourly cleanup drops old sign-in failures and expired pairing codes', async () => {
  const { call, create, server } = setup();
  const desk = (await create()).body.token;
  for (let attempt = 0; attempt < 3; attempt++) await call('/account/sign-in', { username: 'me@x.co', authKey: authKey('b') });
  await call('/account/sign-in', { username: 'other@x.co', authKey: authKey('b') });
  for (const id of ['3', '4']) await call('/devices/pair', { name: 'Late', grants: { secrets: false, settings: true, dictionary: null }, pairId: pairId(id), payload: envelope() }, desk);
  const failures = [...server.tables.signInFailures.values()];
  for (const row of failures.slice(0, 2)) row.at = Date.now() - 61 * 60 * 1000;
  [...server.tables.pairings.values()][0].expiresAt = Date.now() - 1;
  assert.deepEqual(await auth.cleanupExpired._handler(server.db, {}), { failures: 2, pairings: 1 });
  assert.equal(server.tables.signInFailures.size, 2);
  assert.deepEqual([...server.tables.pairings.values()].map(row => row.pairId), [pairId('4')]);
  assert.equal(crons.export().includes('auth:cleanupExpired'), true, 'scheduled hourly');
});

test('signing out revokes only this device', async () => {
  const { call, create, pair } = setup();
  const desk = (await create()).body.token;
  const phone = (await pair(desk, { secrets: true, settings: true, dictionary: 'Personal' })).body.token;
  assert.equal((await call('/account/sign-out', {}, phone)).status, 200);
  assert.equal((await call('/account/me', {}, phone)).status, 401);
  assert.equal((await call('/account/me', {}, desk)).status, 200);
  assert.equal((await call('/account/me', {})).status, 401);
});
