const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HistoryStore } = require('../history-store.cjs');

// Reversible stand-in for safeStorage; a "BAD" prefix simulates a value encrypted for another Windows profile.
const crypto = {
  encryptString: value => Buffer.from('ENC' + Buffer.from(value).toString('base64')),
  decryptString: value => { const text = value.toString(); if (!text.startsWith('ENC')) throw new Error('cannot decrypt'); return Buffer.from(text.slice(3), 'base64').toString(); }
};
const entry = (id, minutes, extra = {}) => ({ id, text: `Text ${id}`, metrics: { started: new Date(Date.UTC(2026, 10, 1, 9, minutes)).toISOString() }, ...extra });
const temp = async () => path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'lw-history-')), 'history.sqlite');

test('saves, updates and removes one entry at a time', async () => {
  const store = new HistoryStore(await temp(), crypto);
  await store.upsert(entry('a', 1), { bytes: Buffer.from('RIFF-a'), format: 'wav' });
  await store.upsert(entry('b', 2));
  await store.upsert({ ...entry('a', 1), text: 'Edited' });
  assert.deepEqual((await store.read()).map(item => [item.id, item.text, item.hasAudio]), [['b', 'Text b', false], ['a', 'Edited', true]]);
  assert.deepEqual(await store.readAudio('a'), { bytes: Buffer.from('RIFF-a'), format: 'wav' }, 'updating text keeps the recording');
  await store.remove('a');
  assert.deepEqual((await store.read()).map(item => item.id), ['b']);
  store.close();
});

test('an unreadable row is skipped and does not block saving', async () => {
  const file = await temp();
  const store = new HistoryStore(file, crypto);
  await store.upsert(entry('good', 1));
  store.database.prepare("INSERT INTO History (id, text, metrics, createdAt) VALUES ('bad', ?, ?, '2026-11-01T09:00:00.000Z')").run(Buffer.from('BAD'), Buffer.from('BAD'));
  const reopened = new HistoryStore(file, crypto);
  assert.deepEqual((await reopened.read()).map(item => item.id), ['good']);
  assert.equal(reopened.skipped, 1);
  await reopened.upsert(entry('new', 5));
  assert.deepEqual((await reopened.read()).map(item => item.id), ['new', 'good']);
  store.close(); reopened.close();
});

test('an unreadable legacy file is set aside instead of retried forever', async () => {
  const file = await temp(), legacy = path.join(path.dirname(file), 'history.bin');
  await fs.writeFile(legacy, 'BAD');
  const store = new HistoryStore(file, crypto, legacy);
  assert.deepEqual(await store.read(), []);
  await fs.access(legacy + '.unreadable');
  store.close();
});

test('imports readable legacy history once', async () => {
  const file = await temp(), legacy = path.join(path.dirname(file), 'history.bin');
  await fs.writeFile(legacy, crypto.encryptString(JSON.stringify([entry('old', 1)])));
  const store = new HistoryStore(file, crypto, legacy);
  assert.deepEqual((await store.read()).map(item => item.id), ['old']);
  await store.remove('old');
  assert.deepEqual(await new HistoryStore(file, crypto, legacy).read(), [], 'not imported again');
  store.close();
});
