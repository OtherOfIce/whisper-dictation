const fs = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Encrypted local history. Each change touches only its own row, so saving stays cheap however long history gets.
// A row that cannot be decrypted (for example after a Windows profile change) is left in place and skipped, rather
// than blocking every later save; `skipped` reports how many were set aside on the last read.
class HistoryStore {
  constructor(file, crypto, legacyFile = null) {
    this.file = file; this.crypto = crypto; this.legacyFile = legacyFile;
    this.queue = Promise.resolve(); this.initialized = null; this.database = null; this.skipped = 0;
  }
  async initialize() {
    if (this.initialized) return this.initialized;
    this.initialized = (async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      this.withDatabase(database => database.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS History (
          id TEXT PRIMARY KEY, text BLOB NOT NULL, rawText BLOB, metrics BLOB NOT NULL,
          audio BLOB, audioFormat TEXT, alternatives BLOB, createdAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS OpenRouterCosts (
          date TEXT NOT NULL, category TEXT NOT NULL, model TEXT NOT NULL,
          provider TEXT NOT NULL, endpoint TEXT NOT NULL, amount REAL NOT NULL, requests INTEGER NOT NULL,
          PRIMARY KEY (date, category, model, provider, endpoint)
        );
        CREATE TABLE IF NOT EXISTS Metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `));
      this.withDatabase(database => {
        const columns = new Set(database.prepare('PRAGMA table_info(History)').all().map(column => column.name));
        if (!columns.has('alternatives')) database.exec('ALTER TABLE History ADD COLUMN alternatives BLOB');
      });
      await this.importLegacyHistory();
    })();
    return this.initialized;
  }
  // The pre-SQLite history file is imported once. If it cannot be read it is renamed aside rather than retried forever.
  async importLegacyHistory() {
    if (!this.legacyFile) return;
    const imported = this.withDatabase(database => database.prepare("SELECT value FROM Metadata WHERE key = 'legacyImported'").get());
    if (imported) return;
    let history = [];
    try {
      history = JSON.parse(this.crypto.decryptString(await fs.readFile(this.legacyFile)));
      this.validate(history);
    } catch (error) {
      history = [];
      if (error.code !== 'ENOENT') await fs.rename(this.legacyFile, this.legacyFile + '.unreadable').catch(() => {});
    }
    this.transaction(database => { for (const entry of history) this.upsertRow(database, entry); });
    this.withDatabase(database => database.prepare("INSERT OR REPLACE INTO Metadata (key, value) VALUES ('legacyImported', ?)").run(new Date().toISOString()));
  }
  async read() {
    await this.initialize();
    const rows = this.withDatabase(database => database.prepare('SELECT id, text, rawText, metrics, alternatives, audio IS NOT NULL AS hasAudio FROM History ORDER BY createdAt DESC, rowid DESC').all());
    const history = []; let skipped = 0;
    for (const row of rows) {
      try {
        const entry = {
          id: row.id, text: this.decrypt(row.text),
          ...(row.rawText == null ? {} : { rawText: this.decrypt(row.rawText) }),
          ...(row.alternatives == null ? {} : { alternatives: JSON.parse(this.decrypt(row.alternatives)) }),
          metrics: JSON.parse(this.decrypt(row.metrics)), hasAudio: row.hasAudio === 1
        };
        this.validate([entry]); history.push(entry);
      } catch { skipped++; }
    }
    this.skipped = skipped;
    return history;
  }
  // Saves one entry (and its recording, when given). Existing audio is kept when none is passed.
  upsert(entry, recording = null) {
    const snapshot = structuredClone(entry);
    return this.enqueue(() => { this.validate([snapshot]); this.transaction(database => this.upsertRow(database, snapshot, recording)); });
  }
  remove(id) { return this.enqueue(() => this.withDatabase(database => database.prepare('DELETE FROM History WHERE id = ?').run(id))); }
  // Replaces all history. Kept for tests and bulk imports; normal saves use upsert and remove.
  write(history, audioById = new Map()) {
    const snapshot = structuredClone(history); const recordings = new Map(audioById);
    return this.enqueue(() => {
      this.validate(snapshot);
      this.transaction(database => {
        const keep = new Set(snapshot.map(entry => entry.id));
        for (const { id } of database.prepare('SELECT id FROM History').all()) if (!keep.has(id)) database.prepare('DELETE FROM History WHERE id = ?').run(id);
        for (const entry of snapshot) this.upsertRow(database, entry, recordings.get(entry.id));
      });
    });
  }
  enqueue(work) {
    const next = this.queue.catch(() => {}).then(async () => { await this.initialize(); return work(); });
    this.queue = next; return next;
  }
  upsertRow(database, entry, recording = null) {
    database.prepare(`
      INSERT INTO History (id, text, rawText, metrics, audio, audioFormat, alternatives, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET text = excluded.text, rawText = excluded.rawText,
        metrics = excluded.metrics, audio = COALESCE(excluded.audio, History.audio),
        audioFormat = COALESCE(excluded.audioFormat, History.audioFormat), alternatives = excluded.alternatives,
        createdAt = excluded.createdAt
    `).run(entry.id, this.encrypt(entry.text), typeof entry.rawText === 'string' ? this.encrypt(entry.rawText) : null,
      this.encrypt(JSON.stringify(entry.metrics)), recording?.bytes ?? null, recording?.format ?? null,
      Array.isArray(entry.alternatives) && entry.alternatives.length ? this.encrypt(JSON.stringify(entry.alternatives)) : null,
      entry.metrics.started);
  }
  async readAudio(id) {
    await this.initialize();
    const row = this.withDatabase(database => database.prepare('SELECT audio, audioFormat FROM History WHERE id = ?').get(id));
    if (!row?.audio) return null;
    const bytes = Buffer.from(row.audio);
    const header = bytes.subarray(0, 4).toString('ascii');
    if (header === 'RIFF' || header.startsWith('ID3') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return { bytes, format: row.audioFormat || (header === 'RIFF' ? 'wav' : 'mp3') };
    // Builds that briefly encrypted audio stored safeStorage(base64(wav)). Keep those recordings readable.
    return { bytes: Buffer.from(this.decrypt(bytes), 'base64'), format: row.audioFormat || 'wav' };
  }
  async readCostLedger() {
    await this.initialize();
    return this.withDatabase(database => {
      const through = database.prepare("SELECT value FROM Metadata WHERE key = 'openRouterCostsThrough'").get()?.value;
      const importedAt = database.prepare("SELECT value FROM Metadata WHERE key = 'openRouterCostsImportedAt'").get()?.value;
      if (!through || !importedAt) return null;
      const rows = database.prepare('SELECT date, category, model, provider, endpoint, amount, requests FROM OpenRouterCosts ORDER BY date, category, model, provider, endpoint').all()
        .map(row => ({ ...row, requests: Number(row.requests) }));
      return { rows, through, importedAt };
    });
  }
  async replaceCostLedger(ledger) {
    this.validateCostLedger(ledger);
    await this.initialize();
    this.transaction(database => {
      const insert = database.prepare('INSERT INTO OpenRouterCosts (date, category, model, provider, endpoint, amount, requests) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const metadata = database.prepare('INSERT OR REPLACE INTO Metadata (key, value) VALUES (?, ?)');
      database.exec('DELETE FROM OpenRouterCosts');
      for (const row of ledger.rows) insert.run(row.date, row.category, row.model, row.provider, row.endpoint, row.amount, row.requests);
      metadata.run('openRouterCostsThrough', ledger.through);
      metadata.run('openRouterCostsImportedAt', ledger.importedAt);
    });
  }
  validate(history) {
    if (!Array.isArray(history) || history.some(entry => typeof entry.id !== 'string' || typeof entry.text !== 'string'
      || !entry.metrics || !Number.isFinite(Date.parse(entry.metrics.started)) || (entry.alternatives != null && (!Array.isArray(entry.alternatives)
        || entry.alternatives.some(alternate => typeof alternate.id !== 'string' || typeof alternate.text !== 'string'
          || !alternate.metrics || !Number.isFinite(Date.parse(alternate.metrics.started))))))) throw new Error('Invalid history');
  }
  validateCostLedger(ledger) {
    if (!ledger || !Array.isArray(ledger.rows) || !Number.isFinite(Date.parse(ledger.through)) || !Number.isFinite(Date.parse(ledger.importedAt))
      || ledger.rows.some(row => typeof row.date !== 'string' || !['voice', 'cleanup'].includes(row.category)
        || typeof row.model !== 'string' || typeof row.provider !== 'string' || typeof row.endpoint !== 'string'
        || !Number.isFinite(row.amount) || row.amount < 0 || !Number.isSafeInteger(row.requests) || row.requests < 0))
      throw new Error('Invalid OpenRouter cost activity');
  }
  encrypt(value) { return this.crypto.encryptString(value); }
  decrypt(value) { return this.crypto.decryptString(Buffer.from(value)); }
  withDatabase(action) {
    this.database ??= new DatabaseSync(this.file);
    return action(this.database);
  }
  transaction(action) {
    return this.withDatabase(database => {
      database.exec('BEGIN IMMEDIATE');
      try { const result = action(database); database.exec('COMMIT'); return result; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    });
  }
  close() { this.database?.close(); this.database = null; }
}
module.exports = { HistoryStore };
