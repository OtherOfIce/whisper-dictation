import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from '../convex/http.js';

const handler = http.getRoutes()[0][2]._handler;
const key = 'test_key_'.repeat(4);
test('HTTP endpoint rejects unauthenticated requests and only passes dictionary changes', async () => {
  const previous = process.env.DICTIONARY_SYNC_KEY;
  process.env.DICTIONARY_SYNC_KEY = key;
  try {
    let called = false;
    const context = { runMutation: async (_, args) => { called = true; assert.deepEqual(args, { add: ['Astra'], remove: [] }); return { terms: ['Astra'] }; } };
    const request = (body, token) => new Request('https://test.convex.site/dictionary/sync', {
      method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body)
    });
    assert.equal((await handler(context, request({ add: [], remove: [] }))).status, 401);
    assert.equal(called, false);
    assert.equal((await handler(context, request({ add: 'invalid', remove: [] }, key))).status, 400);
    assert.equal(called, false);
    const response = await handler(context, request({ add: ['Astra'], remove: [], audio: 'ignored' }, key));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { terms: ['Astra'] });
    delete process.env.DICTIONARY_SYNC_KEY;
    assert.equal((await handler(context, request({ add: [], remove: [] }, key))).status, 401);
  } finally {
    if (previous === undefined) delete process.env.DICTIONARY_SYNC_KEY;
    else process.env.DICTIONARY_SYNC_KEY = previous;
  }
});
