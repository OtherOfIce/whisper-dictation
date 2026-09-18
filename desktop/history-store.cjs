const fs = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

class HistoryStore {
  constructor(file, crypto, legacyFile = null) {
    this.file = file; this.crypto = crypto; this.legacyFile = legacyFile;
    this.queue = Promise.resolve(); this.readFailed = false; this.initialized = null;
  }
  async initialize() {
    if (this.initialized) return this.initialized;
    this.initialized = (async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      this.withDatabase(database => database.exec(`
        CREATE TABLE IF NOT EXISTS History (
          id TEXT PRIMARY KEY, text BLOB NOT NULL, rawText BLOB, metrics BLOB NOT NULL,
          audio BLOB, audioFormat TEXT, createdAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS OpenRouterCosts (
          date TEXT NOT NULL, category TEXT NOT NULL, model TEXT NOT NULL,
          provider TEXT NOT NULL, endpoint TEXT NOT NULL, amount REAL NOT NULL, requests INTEGER NOT NULL,
          PRIMARY KEY (date, category, model, provider, endpoint)
        );
        CREATE TABLE IF NOT EXISTS Metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `));
      await this.importLegacyHistory();
    })();
    return this.initialized;
  }
  async importLegacyHistory() {
    if (!this.legacyFile) return;
    const imported = this.withDatabase(database => database.prepare("SELECT value FROM Metadata WHERE key = 'legacyImported'").get());
    if (imported) return;
    let history = [];
    try {
      history = JSON.parse(this.crypto.decryptString(await fs.readFile(this.legacyFile)));
      this.validate(history);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.replace(history);
    this.withDatabase(database => database.prepare("INSERT OR REPLACE INTO Metadata (key, value) VALUES ('legacyImported', ?)").run(new Date().toISOString()));
  }
  async read() {
    try {
      await this.initialize();
      const rows = this.withDatabase(database => database.prepare('SELECT id, text, rawText, metrics, audio IS NOT NULL AS hasAudio FROM History ORDER BY createdAt DESC, rowid DESC').all());
      const history = rows.map(row => ({
        id: row.id, text: this.decrypt(row.text),
        ...(row.rawText == null ? {} : { rawText: this.decrypt(row.rawText) }),
        metrics: JSON.parse(this.decrypt(row.metrics)), hasAudio: row.hasAudio === 1
      }));
      this.validate(history); return history;
    } catch (error) { this.readFailed = true; throw error; }
  }
  write(history, audioById = new Map()) {
    if (this.readFailed) return Promise.reject(new Error('Existing history could not be read.'));
    const snapshot = structuredClone(history); const recordings = new Map(audioById);
    this.queue = this.queue.catch(() => {}).then(async () => {
      await this.initialize(); this.validate(snapshot); this.replace(snapshot, recordings);
    });
    return this.queue;
  }
  async readAudio(id) {
    await this.initialize();
    const row = this.withDatabase(database => database.prepare('SELECT audio, audioFormat FROM History WHERE id = ?').get(id));
    if (!row?.audio) return null;
    const bytes = Buffer.from(row.audio);
    if (bytes.subarray(0, 4).toString('ascii') === 'RIFF') return { bytes, format: row.audioFormat };
    // Builds that briefly encrypted audio stored safeStorage(base64(wav)). Keep those recordings readable.
    return { bytes: Buffer.from(this.decrypt(bytes), 'base64'), format: row.audioFormat };
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
    this.withDatabase(database => {
      const insert = database.prepare(`
        INSERT INTO OpenRouterCosts (date, category, model, provider, endpoint, amount, requests)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const metadata = database.prepare('INSERT OR REPLACE INTO Metadata (key, value) VALUES (?, ?)');
      database.exec('BEGIN IMMEDIATE');
      try {
        database.exec('DELETE FROM OpenRouterCosts');
        for (const row of ledger.rows) insert.run(row.date, row.category, row.model, row.provider, row.endpoint, row.amount, row.requests);
        metadata.run('openRouterCostsThrough', ledger.through);
        metadata.run('openRouterCostsImportedAt', ledger.importedAt);
        database.exec('COMMIT');
      } catch (error) { database.exec('ROLLBACK'); throw error; }
    });
  }
  replace(history, audioById = new Map()) {
    this.withDatabase(database => {
      const upsert = database.prepare(`
        INSERT INTO History (id, text, rawText, metrics, audio, audioFormat, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET text = excluded.text, rawText = excluded.rawText,
          metrics = excluded.metrics, audio = COALESCE(excluded.audio, History.audio),
          audioFormat = COALESCE(excluded.audioFormat, History.audioFormat), createdAt = excluded.createdAt
      `);
      const remove = database.prepare('DELETE FROM History WHERE id = ?');
      const existing = new Set(database.prepare('SELECT id FROM History').all().map(row => row.id));
      database.exec('BEGIN IMMEDIATE');
      try {
        for (const entry of history) {
          const recording = audioById.get(entry.id);
          upsert.run(entry.id, this.encrypt(entry.text), typeof entry.rawText === 'string' ? this.encrypt(entry.rawText) : null,
            this.encrypt(JSON.stringify(entry.metrics)), recording?.bytes ?? null,
            recording?.format ?? null, entry.metrics.started);
          existing.delete(entry.id);
        }
        for (const id of existing) remove.run(id);
        database.exec('COMMIT');
      } catch (error) { database.exec('ROLLBACK'); throw error; }
    });
  }
  validate(history) {
    if (!Array.isArray(history) || history.some(entry => typeof entry.id !== 'string' || typeof entry.text !== 'string'
      || !entry.metrics || !Number.isFinite(Date.parse(entry.metrics.started)))) throw new Error('Invalid history');
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
    const database = new DatabaseSync(this.file);
    try { return action(database); } finally { database.close(); }
  }
}
module.exports = { HistoryStore };
