using System.Text.Json;
using System.Threading.Channels;
using LocalWhisper.Streaming;

namespace LocalWhisper;

internal static class StreamingDiagnosticsChecks
{
    internal static async Task RunAsync(Action<bool, string> check)
    {
        var metrics = new SessionMetrics();
        var socket = new DiagnosticTransport();
        var session = Session(socket, metrics);
        session.EnqueuePcm(new byte[1280]);
        await socket.FirstAudio.Task.WaitAsync(TimeSpan.FromSeconds(3));
        socket.Emit("transcript-partial", "private provisional words");
        await Until(() => metrics.Snapshot().StreamingAttempts[0].TranscriptEvents == 1);
        var first = metrics.Snapshot().StreamingAttempts[0];
        check(first.ConnectedMs is not null && first.FirstTranscriptMs == first.LastTranscriptMs,
            "Streaming progress is recorded before Stop and completion");

        socket.Emit("transcript-final", "private segment");
        socket.Emit("transcript-delta", "private delta", "delta");
        await Until(() => metrics.Snapshot().StreamingAttempts[0].TranscriptEvents == 3);
        metrics.Stopped();
        var last = metrics.Snapshot().StreamingAttempts[0];
        check(first.TranscriptEvents == 1 && last.LastTranscriptMs >= first.LastTranscriptMs
            && last.LastTranscriptMs <= metrics.Snapshot().StopMs,
            "Snapshots retain their progress while later segment and delta events advance the last-text timing");

        var finished = session.FinishAsync();
        await socket.InputDone.Task.WaitAsync(TimeSpan.FromSeconds(3));
        await Until(() => metrics.Snapshot().StreamingAttempts[0].InputCompletedMs is not null);
        socket.Emit("finish", "Completed transcript.");
        check(await finished.WaitAsync(TimeSpan.FromSeconds(3)) == "Completed transcript.", "Diagnostics preserve completed transcript behavior");
        var completed = metrics.Snapshot().StreamingAttempts[0];
        check(completed is { Outcome: "Completed", FailureStage: null, TranscriptEvents: 3 }
            && completed.LastTranscriptMs == last.LastTranscriptMs && completed.EndedMs >= completed.InputCompletedMs,
            "Terminal completion never overwrites the last intermediate text or counts as another text update");
        var json = JsonSerializer.Serialize(metrics.Snapshot(), new JsonSerializerOptions(JsonSerializerDefaults.Web));
        check(json.Contains("\"streamingAttempts\"") && !json.Contains("private") && !json.Contains("test-only")
            && !json.Contains("Completed transcript."), "Serialized streaming diagnostics contain timings, not words or credentials");

        // A timeout after partial text must remain attributable to the original attempt after recovery.
        var stalledSocket = new DiagnosticTransport();
        var stalled = Session(stalledSocket, metrics, finishTimeout: TimeSpan.FromMilliseconds(30));
        stalled.EnqueuePcm(new byte[1280]);
        await stalledSocket.FirstAudio.Task.WaitAsync(TimeSpan.FromSeconds(3));
        stalledSocket.Emit("transcript-partial", "private text");
        await Until(() => metrics.Snapshot().StreamingAttempts[1].TranscriptEvents == 1);
        await ExpectFailure(stalled.FinishAsync());
        var failed = metrics.Snapshot().StreamingAttempts[1];
        check(failed is { Outcome: "Failed", FailureStage: "finalize", TranscriptEvents: 1 }
            && failed.InputCompletedMs is not null && failed.EndedMs >= failed.LastTranscriptMs,
            "Finalization timeout records that text arrived before the failure");
        check(metrics.Snapshot().StreamingAttempts[0] == completed,
            "Later attempts do not overwrite completed or failed stream evidence");
        var recoverySocket = new DiagnosticTransport();
        var recovery = Session(recoverySocket, metrics);
        recovery.EnqueuePcm(new byte[1280]);
        var recovered = recovery.FinishAsync();
        await recoverySocket.InputDone.Task.WaitAsync(TimeSpan.FromSeconds(3));
        recoverySocket.Emit("finish", "Recovered transcript.");
        await recovered.WaitAsync(TimeSpan.FromSeconds(3));
        check(metrics.Snapshot().StreamingAttempts[1] == failed
            && metrics.Snapshot().StreamingAttempts[2] is { Outcome: "Completed", LastTranscriptMs: null, TranscriptEvents: 0 },
            "A successful recovery with only terminal text preserves the original failure and does not invent intermediate progress");

        var blocked = new DiagnosticTransport { BlockConnect = true };
        var connectMetrics = new SessionMetrics();
        await ExpectFailure(Session(blocked, connectMetrics, connectTimeout: TimeSpan.FromMilliseconds(20)).FinishAsync());
        check(connectMetrics.Snapshot().StreamingAttempts.Single() is
            { Outcome: "Failed", FailureStage: "connect", ConnectedMs: null, LastTranscriptMs: null, TranscriptEvents: 0 },
            "A connection timeout is distinguishable from a stream that returned text");

        var interruptedMetrics = new SessionMetrics();
        var interruptedSocket = new DiagnosticTransport();
        var interrupted = Session(interruptedSocket, interruptedMetrics);
        interrupted.EnqueuePcm(new byte[1280]);
        await interruptedSocket.FirstAudio.Task.WaitAsync(TimeSpan.FromSeconds(3));
        interruptedSocket.Emit("transcript-partial", "private text");
        await Until(() => interruptedMetrics.Snapshot().StreamingAttempts[0].TranscriptEvents == 1);
        interruptedSocket.Emit("error", "private provider payload");
        // Do not finish input: this failure happened while capture was still active.
        await Until(() => interruptedSocket.Disposed);
        await ExpectFailure(interrupted.FinishAsync());
        check(interruptedMetrics.Snapshot().StreamingAttempts.Single() is
            { Outcome: "Failed", FailureStage: "stream", InputCompletedMs: null, TranscriptEvents: 1 },
            "A failure during recording is distinct from waiting for final completion");

        using var cancellation = new CancellationTokenSource();
        var cancelMetrics = new SessionMetrics();
        var cancelSocket = new DiagnosticTransport();
        var cancelled = Session(cancelSocket, cancelMetrics, token: cancellation.Token);
        cancelled.EnqueuePcm(new byte[1280]);
        await cancelSocket.FirstAudio.Task.WaitAsync(TimeSpan.FromSeconds(3));
        cancellation.Cancel();
        try { await cancelled.FinishAsync(); throw new Exception("Expected cancellation"); }
        catch (OperationCanceledException) { }
        check(cancelMetrics.Snapshot().StreamingAttempts.Single() is { Outcome: "Cancelled", FailureStage: null, EndedMs: not null }
            && cancelled.Failed == 0, "User cancellation is not reported as a streaming provider failure");
    }

    private static StreamingSession Session(DiagnosticTransport socket, SessionMetrics metrics, CancellationToken token = default,
        TimeSpan? connectTimeout = null, TimeSpan? finishTimeout = null) =>
        new(new GatewayStreamingProtocol("test-only"), metrics, token, () => socket,
            connectTimeout: connectTimeout, finishTimeout: finishTimeout);

    private static async Task Until(Func<bool> ready)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        while (!ready()) await Task.Delay(1, timeout.Token);
    }
    private static async Task ExpectFailure(Task<string> task)
    {
        try { await task.WaitAsync(TimeSpan.FromSeconds(3)); throw new Exception("Expected failure"); }
        catch (Exception ex) when (ex is HttpRequestException or TimeoutException) { }
    }

    private sealed class DiagnosticTransport : IStreamingTransport
    {
        private readonly Channel<string> events = Channel.CreateUnbounded<string>();
        internal bool BlockConnect { get; init; }
        internal volatile bool Disposed;
        internal readonly TaskCompletionSource FirstAudio = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal readonly TaskCompletionSource InputDone = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal void Emit(string type, string text, string field = "text") =>
            events.Writer.TryWrite(JsonSerializer.Serialize(new Dictionary<string, string> { ["type"] = type, [field] = text }));
        public async Task ConnectAsync(Uri uri, IReadOnlyDictionary<string, string> headers, IReadOnlyList<string> protocols, CancellationToken token)
        {
            if (BlockConnect) await Task.Delay(Timeout.Infinite, token);
        }
        public Task SendAsync(ReadOnlyMemory<byte> bytes, bool text, CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            if (!text) FirstAudio.TrySetResult();
            else
            {
                using var json = JsonDocument.Parse(bytes);
                if (json.RootElement.GetProperty("type").GetString() == "transcription-stream.audio-done") InputDone.TrySetResult();
            }
            return Task.CompletedTask;
        }
        public async Task<JsonDocument> ReceiveAsync(CancellationToken token) => JsonDocument.Parse(await events.Reader.ReadAsync(token));
        public void Dispose() { Disposed = true; events.Writer.TryComplete(); }
    }
}
