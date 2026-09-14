const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { readWisprDictionary } = require('../wispr-dictionary.cjs');

test('reads active Wispr terms, converts replacements, and skips snippets', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-whisper-dictionary-'));
  const file = path.join(directory, 'flow.sqlite');
  try {
    const database = new DatabaseSync(file);
    database.exec('CREATE TABLE Dictionary (phrase TEXT, replacement TEXT, isSnippet INTEGER, isDeleted INTEGER)');
    const insert = database.prepare('INSERT INTO Dictionary VALUES (?, ?, ?, ?)');
    insert.run('Astra', null, 0, 0);
    insert.run('astra', null, 0, 0);
    insert.run('btw', 'by the way', 0, 0);
    insert.run('signature', 'Kind regards', 1, 0);
    insert.run('old', null, 0, 1);
    database.close();
    assert.deepEqual(readWisprDictionary(file), {
      terms: ['Astra', 'by the way'], skippedSnippets: 1, convertedReplacements: 1
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('reports a missing Wispr database clearly', () => {
  assert.throws(() => readWisprDictionary(path.join(os.tmpdir(), 'missing-wispr-flow.sqlite')), /dictionary was not found/);
});
