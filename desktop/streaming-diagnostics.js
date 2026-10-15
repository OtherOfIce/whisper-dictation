// Shared by the History drawer and its tests. Older history has no attempts.
function streamingFacts(metrics, modelNames, formatDuration) {
  const facts = [];
  const phases = { connect: 'connecting', stream: 'streaming audio', finalize: 'waiting for the completed transcript' };
  for (const [index, attempt] of (metrics.streamingAttempts ?? []).entries()) {
    const label = `Stream ${index + 1}`;
    const model = modelNames[attempt.model] || attempt.model;
    const status = attempt.outcome === 'Failed'
      ? `Failed while ${phases[attempt.failureStage] || attempt.failureStage || 'streaming'}` : attempt.outcome;
    facts.push([label, `${model} · ${status}`]);
    facts.push([`${label} connection`, attempt.connectedMs == null
      ? 'Not established' : `${formatDuration(attempt.connectedMs - attempt.startedMs)} to connect`]);
    facts.push([`${label} text updates`, `${attempt.transcriptEvents ?? 0}`]);
    if (attempt.firstTranscriptMs != null)
      facts.push([`${label} first text`, `${formatDuration(attempt.firstTranscriptMs - attempt.startedMs)} after stream started`]);
    if (attempt.lastTranscriptMs != null) {
      const sinceStop = metrics.stopMs == null ? null : attempt.lastTranscriptMs - metrics.stopMs;
      facts.push([`${label} last text`, sinceStop == null
        ? `${formatDuration(attempt.lastTranscriptMs - attempt.startedMs)} after stream started`
        : `${formatDuration(Math.abs(sinceStop))} ${sinceStop < 0 ? 'before' : 'after'} Stop`]);
      if (attempt.endedMs != null)
        facts.push([`${label} time without text`, `${formatDuration(attempt.endedMs - attempt.lastTranscriptMs)} before ${attempt.outcome === 'Failed' ? 'failure' : attempt.outcome === 'Cancelled' ? 'cancellation' : 'completion'}`]);
    } else {
      facts.push([`${label} last text`, 'No intermediate text received']);
    }
    if (attempt.inputCompletedMs != null && attempt.endedMs != null)
      facts.push([`${label} final wait`, `${formatDuration(attempt.endedMs - attempt.inputCompletedMs)} after audio was sent`]);
  }
  return facts;
}

if (typeof module !== 'undefined') module.exports = { streamingFacts };
