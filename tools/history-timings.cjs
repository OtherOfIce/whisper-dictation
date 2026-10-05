// Run with Node. The child uses Electron's existing account-bound encryption key.
const path = require('node:path');

if (!process.versions.electron && process.argv.includes('--help')) {
  console.log('Usage: node tools/history-timings.cjs [--days 7] [--from ISO_DATE] [--to ISO_DATE] [--user-data DIRECTORY]\nOutputs aggregate timing JSON only. See docs/history-queries.md for definitions and encryption details.');
  process.exit(0);
}

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(require('../desktop/node_modules/electron'), [__filename, ...process.argv.slice(2)],
    { env, stdio: 'inherit', windowsHide: true });
  if (child.error) console.error(child.error.message);
  process.exit(child.status ?? 1);
} else {
  const { app, safeStorage } = require('electron');
  const { DatabaseSync } = require('node:sqlite');
  const args = process.argv.slice(2);
  const option = name => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a value`);
    return args[index + 1];
  };
  const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const median = values => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const summarize = records => ({
    count: records.length,
    ...Object.fromEntries(['transcriptionMs', 'cleanupMs', 'otherMs', 'totalMs', 'audioSeconds',
      'transcriptionPct', 'cleanupPct', 'otherPct', 'transcriptionOfTwoStagesPct', 'cleanupOfTwoStagesPct']
      .map(key => [key, { mean: mean(records.map(r => r[key])), median: median(records.map(r => r[key])) }])),
    weightedShares: Object.fromEntries(['transcription', 'cleanup', 'other'].map(stage =>
      [stage, records.length ? 100 * records.reduce((sum, r) => sum + r[`${stage}Ms`], 0)
        / records.reduce((sum, r) => sum + r.totalMs, 0) : null]))
  });
  async function main() {
    const userData = path.resolve(option('--user-data') ?? path.join(process.env.APPDATA, 'Local Whisper'));
    app.setPath('userData', userData);
    const end = new Date(option('--to') ?? Date.now());
    const days = Number(option('--days') ?? 7);
    const start = new Date(option('--from') ?? end.getTime() - days * 86400000);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end)
      throw new Error('Provide a valid date range, with --from before --to');
    await app.whenReady();
    const database = new DatabaseSync(path.join(userData, 'history.sqlite'), { readOnly: true });
    const records = [], excluded = {}, outcomes = {};
    let rows;
    try {
      rows = database.prepare('SELECT metrics FROM History WHERE julianday(createdAt) >= julianday(?) AND julianday(createdAt) < julianday(?)')
        .all(start.toISOString(), end.toISOString());
      for (const row of rows) {
        const metrics = JSON.parse(safeStorage.decryptString(Buffer.from(row.metrics)));
        outcomes[metrics.outcome] = (outcomes[metrics.outcome] ?? 0) + 1;
        const skip = reason => { excluded[reason] = (excluded[reason] ?? 0) + 1; };
        if (metrics.outcome !== 'Pasted') { skip(metrics.outcome); continue; }
        const { stopMs, pasteMs } = metrics;
        if (!Number.isFinite(stopMs) || !Number.isFinite(pasteMs) || pasteMs <= stopMs) { skip('Invalid stop/paste'); continue; }
        const stages = metrics.rows ?? [];
        const cleanup = stages.filter(r => r.name.startsWith('AI cleanup'));
        const paste = stages.find(r => r.name === 'Paste / wait for released keys');
        if (!paste || !Number.isFinite(paste.startMs)) { skip('Missing paste stage'); continue; }
        if (cleanup.length > 1 || stages.some(r => r.name.includes('transcription + cleanup'))) { skip('Combined or ambiguous stages'); continue; }
        const cutoff = cleanup[0]?.startMs ?? paste.startMs;
        if (!Number.isFinite(cutoff) || cutoff < stopMs || cutoff > pasteMs
          || cleanup.some(r => r.running || !Number.isFinite(r.durationMs) || r.durationMs < 0)) { skip('Invalid stage boundaries'); continue; }
        const totalMs = pasteMs - stopMs;
        const transcriptionMs = cutoff - stopMs;
        const cleanupMs = cleanup.length ? Math.max(0, Math.min(pasteMs, cutoff + cleanup[0].durationMs) - cutoff) : 0;
        const otherMs = totalMs - transcriptionMs - cleanupMs;
        if (otherMs < -0.001) { skip('Overlapping stages'); continue; }
        if (!cleanup.length && metrics.cleanupMode && metrics.cleanupMode !== 'off') { skip('Enabled cleanup without timing'); continue; }
        const two = transcriptionMs + cleanupMs;
        records.push({ transcriptionMs, cleanupMs, otherMs: Math.max(0, otherMs), totalMs,
          audioSeconds: metrics.audioSeconds, transcriptionPct: transcriptionMs / totalMs * 100,
          cleanupPct: cleanupMs / totalMs * 100, otherPct: Math.max(0, otherMs) / totalMs * 100,
          transcriptionOfTwoStagesPct: transcriptionMs / two * 100, cleanupOfTwoStagesPct: cleanupMs / two * 100,
          model: metrics.transcriptionModel ?? 'unknown', cleanupMode: metrics.cleanupMode ?? 'unknown',
          hasCleanup: cleanup.length > 0 });
      }
    } finally { database.close(); }
    const groups = {};
    for (const record of records) {
      const key = `${record.model} / ${record.cleanupMode}`;
      (groups[key] ??= []).push(record);
    }
    console.log(JSON.stringify({ from: start.toISOString(), to: end.toISOString(), databaseRows: rows.length,
      outcomes, excluded, all: summarize(records), withCleanup: summarize(records.filter(r => r.hasCleanup)),
      withoutCleanup: summarize(records.filter(r => !r.hasCleanup)),
      byModelAndCleanup: Object.fromEntries(Object.entries(groups).map(([key, values]) => [key, summarize(values)])) }, null, 2));
    app.quit();
  }
  main().catch(error => { console.error(error.message); app.exit(1); });
}
