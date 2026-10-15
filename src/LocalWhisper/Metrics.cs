using System.Diagnostics;

namespace LocalWhisper;

public sealed record TimingRow(string Name, double StartMs, double DurationMs, bool Running);
public sealed record CostRow(string Category, string Model, decimal Amount);
public sealed record HedgeEvent(double CutoffMs, int WinnerAttempt, double WinnerMs, double? LoserMs, double? SavedMs);
public sealed record ParallelRequestEvent(string RaceId, int Attempt, string Model, double DurationMs, string Outcome, bool Selected);
public sealed record RequestEvent(string Model, double DurationMs, string Outcome);
public sealed record FallbackEvent(string Model, string Error);
// Timings only: intermediate transcript text and provider payloads are never stored here.
public sealed record StreamingAttempt(string Model, double StartedMs)
{
    public double? ConnectedMs { get; init; }
    public double? FirstTranscriptMs { get; init; }
    public double? LastTranscriptMs { get; init; }
    public int TranscriptEvents { get; init; }
    public double? InputCompletedMs { get; init; }
    public double? EndedMs { get; init; }
    public string Outcome { get; init; } = "Streaming";
    public string? FailureStage { get; init; }
}
public sealed record MetricsSnapshot(DateTime Started, string Outcome, double AudioSeconds, long AudioBytes, long RequestBytes,
    double ElapsedMs, double? StopMs, double? PasteMs, double MaxUiGapMs, TimingRow[] Rows, CostRow[] Costs, HedgeEvent[] Hedges,
    string TranscriptionModel, string CleanupMode, string RequestedTranscriptionModel, FallbackEvent[] Fallbacks,
    ParallelRequestEvent[] ParallelRequests, RequestEvent[] Requests)
{
    public double? FirstTranscriptMs { get; init; }
    public StreamingAttempt[] StreamingAttempts { get; init; } = [];
}

public sealed class SessionMetrics
{
    private readonly Stopwatch watch = Stopwatch.StartNew();
    private readonly object gate = new();
    private readonly List<Stage> stages = [];
    private readonly List<CostRow> costs = [];
    private readonly List<HedgeEvent> hedges = [];
    private readonly List<FallbackEvent> fallbacks = [];
    private readonly List<ParallelRequestEvent> parallelRequests = [];
    private readonly List<RequestEvent> requests = [];
    private readonly List<StreamingAttempt> streamingAttempts = [];
    private readonly List<Task> background = [];
    private readonly DateTime started = DateTime.Now;
    private double? stopMs, pasteMs;
    private double? firstTranscriptMs;
    private double audioSeconds, maxUiGap;
    private long audioBytes;
    private long requestBytes;
    private string outcome = "Recording";
    private double? finishedMs;
    public string TranscriptionModel { get; set; } = "";
    public string RequestedTranscriptionModel { get; set; } = "";
    public string CleanupMode { get; set; } = "";
    public double ElapsedMs => watch.Elapsed.TotalMilliseconds;
    public IDisposable Measure(string name)
    {
        var stage = new Stage(this, name, ElapsedMs);
        lock (gate) stages.Add(stage);
        return stage;
    }
    public void Audio(double seconds, long bytes) { lock (gate) { audioSeconds = seconds; audioBytes = bytes; } }
    public void RequestSize(long bytes) { lock (gate) requestBytes += bytes; }
    public void Cost(string category, string model, decimal? amount)
    {
        if (amount is not { } value || value < 0) return;
        lock (gate) costs.Add(new(category, model, value));
    }
    public void Stopped() { lock (gate) { stopMs ??= ElapsedMs; outcome = "Transcribing"; } }
    public void FirstTranscript() { lock (gate) firstTranscriptMs ??= ElapsedMs; }
    internal int BeginStreaming(string model)
    {
        lock (gate)
        {
            streamingAttempts.Add(new(model, ElapsedMs));
            return streamingAttempts.Count - 1;
        }
    }
    internal void UpdateStreaming(int attempt, Func<StreamingAttempt, StreamingAttempt> update)
    {
        lock (gate)
        {
            // Shutdown can race a final receive; keep the evidence at the attempt's end.
            if (streamingAttempts[attempt].EndedMs is null)
                streamingAttempts[attempt] = update(streamingAttempts[attempt]);
        }
    }
    public void Hedge(double cutoffMs, int winnerAttempt, double winnerMs, double? loserMs, double? savedMs)
    {
        lock (gate) hedges.Add(new(cutoffMs, winnerAttempt, winnerMs, loserMs, savedMs));
    }
    public void Fallback(string model, string error) { lock (gate) fallbacks.Add(new(model, error)); }
    public void ParallelRequest(ParallelRequestEvent request) { lock (gate) parallelRequests.Add(request); }
    public void Request(string model, double durationMs, string outcome) { lock (gate) requests.Add(new(model, durationMs, outcome)); }
    public void SelectParallelRequest(string raceId, int attempt)
    {
        lock (gate)
        {
            var index = parallelRequests.FindIndex(request => request.RaceId == raceId && request.Attempt == attempt);
            if (index >= 0) parallelRequests[index] = parallelRequests[index] with { Selected = true };
        }
    }
    public void TrackBackground(Task task) { lock (gate) background.Add(task); }
    public async Task WaitForBackgroundAsync()
    {
        Task[] pending;
        lock (gate) pending = background.ToArray();
        await Task.WhenAll(pending).ConfigureAwait(false);
    }
    public void Pasted() { lock (gate) pasteMs = ElapsedMs; }
    public void UiGap(double ms) { lock (gate) maxUiGap = Math.Max(maxUiGap, ms); }
    public void Complete(string result) { lock (gate) { outcome = result; finishedMs = ElapsedMs; } }
    public MetricsSnapshot Snapshot()
    {
        lock (gate) return new(started, outcome, audioSeconds, audioBytes, requestBytes,
            Math.Max(finishedMs ?? ElapsedMs, stages.Count == 0 ? 0 : stages.Max(s => s.End ?? ElapsedMs)), stopMs, pasteMs, maxUiGap,
            stages.Select(s => new TimingRow(s.Name, s.Start, (s.End ?? ElapsedMs) - s.Start, s.End is null)).ToArray(), costs.ToArray(), hedges.ToArray(),
            TranscriptionModel, CleanupMode, RequestedTranscriptionModel, fallbacks.ToArray(), parallelRequests.ToArray(), requests.ToArray())
        { FirstTranscriptMs = firstTranscriptMs, StreamingAttempts = streamingAttempts.ToArray() };
    }
    private sealed class Stage(SessionMetrics owner, string name, double start) : IDisposable
    {
        public string Name { get; } = name;
        public double Start { get; } = start;
        public double? End { get; private set; }
        public void Dispose() { lock (owner.gate) End ??= owner.ElapsedMs; }
    }
}
