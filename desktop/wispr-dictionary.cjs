const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

function readWisprDictionary(file) {
  if (!fs.existsSync(file)) throw new Error('Wispr Flow is installed, but its local dictionary was not found.');
  let database;
  try {
    database = new DatabaseSync(file, { readOnly: true });
    const columns = new Set(database.prepare('PRAGMA table_info(Dictionary)').all().map(column => column.name));
    if (!columns.has('phrase')) throw new Error('The Wispr Flow dictionary format is not supported by this version of Local Whisper.');
    const replacement = columns.has('replacement') ? 'replacement' : columns.has('toReplace') ? 'toReplace' : 'NULL';
    const snippet = columns.has('isSnippet') ? 'isSnippet' : '0';
    const active = columns.has('isDeleted') ? 'WHERE COALESCE(isDeleted, 0) = 0' : '';
    const rows = database.prepare(`SELECT phrase, ${replacement} AS replacement, ${snippet} AS isSnippet FROM Dictionary ${active}`).all();
    const terms = [];
    const seen = new Set();
    let skippedSnippets = 0, convertedReplacements = 0;
    for (const row of rows) {
      if (row.isSnippet) { skippedSnippets++; continue; }
      const hasReplacement = typeof row.replacement === 'string' && row.replacement.trim().length > 0;
      const term = (hasReplacement ? row.replacement : row.phrase)?.trim();
      if (!term) continue;
      if (hasReplacement) convertedReplacements++;
      const key = term.toLocaleLowerCase();
      if (!seen.has(key)) { seen.add(key); terms.push(term); }
    }
    return { terms, skippedSnippets, convertedReplacements };
  } catch (error) {
    if (error.message?.startsWith('The Wispr Flow')) throw error;
    throw new Error('The Wispr Flow dictionary could not be read. Close Wispr Flow and try again.');
  } finally {
    database?.close();
  }
}

module.exports = { readWisprDictionary };
