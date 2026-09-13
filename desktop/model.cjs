function projectTimings(metrics, includeRecording = false) {
  if (!metrics) return { duration: 0, rows: [], completedEarly: 0 };
  const origin = includeRecording ? 0 : (metrics.stopMs ?? metrics.elapsedMs);
  const end = includeRecording ? metrics.elapsedMs : (metrics.pasteMs ?? metrics.elapsedMs);
  const rows = (metrics.rows || []).filter(row => includeRecording ||
    (!['Recording', 'Open microphone'].includes(row.name) && !row.name.startsWith('Clipboard cleanup')));
  return {
    duration: Math.max(0, end - origin),
    completedEarly: rows.filter(row => row.startMs + row.durationMs <= origin).length,
    rows: rows.map(row => ({ ...row, start: Math.max(origin, row.startMs) - origin,
      duration: Math.max(0, Math.min(end, row.startMs + row.durationMs) - Math.max(origin, row.startMs)) }))
      .filter(row => includeRecording || row.duration > 0)
  };
}
module.exports = { projectTimings };
