import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge } from '../convex/terms.js';

test('independent device changes merge without resurrecting deleted terms', () => {
  const first = merge(['Astra', 'Old'], ['Desktop'], ['old']);
  assert.deepEqual(merge(first, ['Phone'], []), ['Astra', 'Desktop', 'Phone']);
  assert.deepEqual(merge(first, ['Desktop'], ['old']), first);
});
test('rejects invalid or oversized merged dictionaries', () => {
  assert.throws(() => merge([], ['bad\nterm'], []));
  assert.throws(() => merge([], ['x'.repeat(121)], []));
  assert.throws(() => merge(Array.from({ length: 1000 }, (_, i) => String(i)), ['extra'], []));
});
