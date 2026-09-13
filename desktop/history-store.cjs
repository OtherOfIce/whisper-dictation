const fs = require('node:fs/promises');
const path = require('node:path');
class HistoryStore {
  constructor(file, crypto) { this.file = file; this.crypto = crypto; this.queue = Promise.resolve(); this.readFailed = false; }
  async read() {
    try {
      const history = JSON.parse(this.crypto.decryptString(await fs.readFile(this.file)));
      if (!Array.isArray(history) || history.some(x => typeof x.id !== 'string' || typeof x.text !== 'string' || !x.metrics || !Number.isFinite(Date.parse(x.metrics.started)))) throw new Error('Invalid history');
      return history;
    } catch (error) { if (error.code === 'ENOENT') return []; this.readFailed = true; throw error; }
  }
  write(history) {
    if (this.readFailed) return Promise.reject(new Error('Existing history could not be read.'));
    const snapshot = JSON.stringify(history);
    this.queue = this.queue.catch(() => {}).then(async () => {
      const encrypted = this.crypto.encryptString(snapshot);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file + '.tmp', encrypted);
      await fs.rename(this.file + '.tmp', this.file);
    });
    return this.queue;
  }
}
module.exports = { HistoryStore };
