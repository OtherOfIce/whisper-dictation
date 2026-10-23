import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fakeDb.js';
import { syncItems } from '../convex/items.js';
import { validateItem } from '../convex/itemsCore.js';

const item = (name, value, updatedAt, deleted = false) => ({ name, value: deleted ? '' : value, deleted, updatedAt });
const everything = { secrets: true, settings: true, history: false, dictionary: 'Personal' };

async function account() {
  const { ctx, tables } = fakeDb();
  for (const [userId, tokenHash] of [['u1', 'h1'], ['u1', 'h2'], ['u2', 'h3']])
    await ctx.db.insert('devices', { userId, tokenHash, name: 'd', admin: true, hasKeys: true, grants: everything, createdAt: 0, lastSeen: Date.now() });
  const sync = (tokenHash, args = {}) => syncItems._handler(ctx, { tokenHash, items: [], ...args });
  return { ctx, tables, sync };
}

test('item validation', () => {
  for (const good of [item('settings.transcriptionModel', '"gpt-transcribe"', 1), item('secrets.openrouter', 'v1.a.b', 1), item('history.today', 'x', 1)]) assert.equal(validateItem(good), null);
  for (const bad of [item('other.x', 'a', 1), item('settings.Bad', 'a', 1), item('settings.x', 'a', -1), item('settings.x', 'a'.repeat(513), 1), item('secrets.x', 'a'.repeat(4097), 1),
    { name: 'settings.x', value: 'a', updatedAt: 1 }, { name: 'settings.x', value: 'a', deleted: true, updatedAt: 1 }, null]) assert.notEqual(validateItem(bad), null);
});

test('newer items win, older ones are ignored, and accounts stay separate', async () => {
  const { sync, tables } = await account();
  assert.equal(await sync('unknown'), null);
  const first = await sync('h1', { items: [item('settings.cleanupMode', '"luna"', 1000)] });
  assert.deepEqual(first.items.map(entry => entry.value), ['"luna"']);
  assert.deepEqual([first.grants, first.admin], [everything, true]);
  await sync('h2', { items: [item('settings.cleanupMode', '"off"', 500)] });
  assert.equal((await sync('h1')).items[0].value, '"luna"', 'an older update does not overwrite');
  assert.equal((await sync('h2', { items: [item('settings.cleanupMode', '"luna-fast"', 2000)] })).items[0].value, '"luna-fast"');
  const tombstone = (await sync('h1', { items: [item('settings.cleanupMode', '', 3000, true)] })).items[0];
  assert.deepEqual([tombstone.deleted, tombstone.value], [true, '']);
  assert.deepEqual((await sync('h3')).items, [], 'another account sees nothing');
  assert.equal(tables.syncItems.size, 1);
});

test('future timestamps are clamped so one device cannot pin an item', async () => {
  const { sync } = await account();
  const before = Date.now();
  const stored = (await sync('h1', { items: [item('settings.raceMai', 'true', before + 10 * 24 * 3600 * 1000)] })).items[0];
  assert.ok(stored.updatedAt <= Date.now() + 5 * 60 * 1000);
  assert.ok(stored.updatedAt >= before);
});

test('the item limit is enforced', async () => {
  const { sync } = await account();
  const many = Array.from({ length: 200 }, (_, index) => item(`settings.k${index}`, '1', 1));
  assert.equal((await sync('h1', { items: many })).items.length, 200);
  await assert.rejects(sync('h1', { items: [item('settings.extra', '1', 1)] }), /Too many/);
});
