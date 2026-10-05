using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using LocalWhisper.Streaming;
using NAudio.Wave;

namespace LocalWhisper;

internal static class StreamingChecks
{
    internal static async Task RunAsync(Action<bool, string> check)
    {
        using var http = new HttpClient();
        var available = new TranscriptionPipeline(http, new("", "", "gateway-only"));
        check(available.Available(TranscriptionModels.MaiStreaming, Enumerable.Repeat("term", 101).ToArray()),
            "Gateway streaming uses its own key and does not inherit Grok dictionary limits");
        check(!available.Available(TranscriptionModels.GrokStreaming, []), "Gateway key does not authorize Grok");
        check(!TranscriptionModels.Describe(TranscriptionModels.MaiStreaming).ParallelRequests
            && !TranscriptionModels.Describe(TranscriptionModels.MaiStreaming).DictionaryHints,
            "MAI streaming does not advertise batch parallelism or dictionary hints");

        foreach (var grok in new[] { false, true })
        {
            var socket = new FakeTransport(grok);
            var metrics = new SessionMetrics();
            var session = Session(socket, grok, metrics);
            var source = Enumerable.Range(0, 4510).Select(index => (byte)(index % 251)).ToArray();
            session.EnqueuePcm(source[..1280]); session.EnqueuePcm(source[1280..]);
            var first = session.FinishAsync(); var second = session.FinishAsync();
            check(ReferenceEquals(first, second), "Repeated Finish observes one streaming task");
            check(await first.WaitAsync(TimeSpan.FromSeconds(3)) == "Hello world.", "Both streaming adapters return complete text without provisional duplicates");
            check(socket.Pcm.SelectMany(frame => frame).SequenceEqual(source), "Streaming preserves PCM queued during connection and flushes every tail byte");
            check(socket.Pcm[0].Length == (grok ? 3200 : 1280)
                && socket.Pcm.Last().Length == source.Length % (grok ? 3200 : 1280), "Provider frame sizes preserve the incomplete final frame");
            check(socket.DoneCount == 1 && socket.Disposed && session.Completed == 1, "Streaming ends input once and disposes the socket");
            check(metrics.Snapshot().FirstTranscriptMs is not null, "Streaming records the first transcript timing");
            if (!grok)
            {
                check(socket.Protocols.SequenceEqual(["ai-gateway-transcription.v1", "ai-gateway-auth.test-only"]), "Gateway uses the verified authentication subprotocols");
                check(socket.Uri?.Host == "ai-gateway.vercel.sh" && socket.Uri.Query.Contains("microsoft%2Fmai-transcribe-2-streaming"), "Gateway connects to the streaming model endpoint");
                check(socket.TextFrames.First().Contains("transcription-stream.start") && socket.TextFrames.First().Contains("16000"), "Gateway sends its 16 kHz PCM start frame");
            }
        }

        foreach (var mode in new[] { "error", "close", "hang", "early" })
        {
            var socket = new FakeTransport(false) { Mode = mode };
            var session = Session(socket, false, new(), finishTimeout: TimeSpan.FromMilliseconds(30));
            session.EnqueuePcm(new byte[1280]);
            await ExpectFailure(session.FinishAsync());
            check(session.Failed == 1 && socket.Disposed, $"Streaming {mode} fails instead of pasting provisional text and releases the socket");
        }

        var blocked = new FakeTransport(false) { BlockConnect = true };
        var overflow = Session(blocked, false, new(), queueLimit: 1280);
        overflow.EnqueuePcm(new byte[2560]);
        await ExpectFailure(overflow.FinishAsync());
        check(overflow.Failed == 1 && overflow.LastError!.Contains("queue"), "Queue overflow fails explicitly instead of dropping audio");

        var timeoutSocket = new FakeTransport(false) { BlockConnect = true };
        var timeout = Session(timeoutSocket, false, new(), connectTimeout: TimeSpan.FromMilliseconds(20));
        await ExpectFailure(timeout.FinishAsync());
        check(timeout.Failure is TimeoutException && timeoutSocket.Disposed, "Connect deadline cancels the underlying connection");

        using (var cancellation = new CancellationTokenSource())
        {
            var socket = new FakeTransport(false) { Mode = "hang" };
            var session = Session(socket, false, new(), token: cancellation.Token);
            session.EnqueuePcm(new byte[1280]);
            await socket.FirstAudio.Task.WaitAsync(TimeSpan.FromSeconds(3));
            var finish = session.FinishAsync(); cancellation.Cancel();
            try { await finish; throw new Exception("Expected streaming cancellation"); }
            catch (OperationCanceledException) { check(session.Failed == 0 && socket.Disposed, "Cancellation closes streaming without classifying it as provider failure"); }
        }

        var replaySocket = new FakeTransport(false);
        var pipeline = new TranscriptionPipeline(http, new("", "", "test-only"), () => replaySocket);
        using var wav = new MemoryStream();
        var replayPcm = Enumerable.Repeat((byte)7, 32000 * 35).ToArray();
        using (var writer = new WaveFileWriter(new NAudio.Utils.IgnoreDisposeStream(wav), new WaveFormat(16000, 16, 1))) writer.Write(replayPcm);
        var replayMetrics = new SessionMetrics();
        var result = await pipeline.Recorded(replayMetrics, []).TranscribeExactAsync(wav.ToArray(), "wav",
            TranscriptionModels.MaiStreaming, [], replayMetrics, default);
        check(result.UsedModel == TranscriptionModels.MaiStreaming && replaySocket.Pcm.SelectMany(frame => frame).SequenceEqual(replayPcm),
            "Saved MAI streaming audio strips WAV headers, applies replay backpressure and keeps the exact model");

        var attempted = new List<string>();
        var fallback = new ModelTranscription((model, _, _, _, _) => { attempted.Add(model); return Task.FromResult("Recovered"); }, _ => true);
        var recovered = await fallback.TranscribeWithFallbackAsync([0], "wav", TranscriptionModels.MaiStreaming, [], new(), default, skipRequested: true);
        check(attempted.SequenceEqual([TranscriptionModels.MaiClean]) && recovered.RequestedModel == TranscriptionModels.MaiStreaming,
            "Failed live MAI streaming recovers using a distinct batch model rather than restarting the failed stream");
    }
    private static StreamingSession Session(FakeTransport socket, bool grok, SessionMetrics metrics, CancellationToken token = default,
        long queueLimit = 32000 * 30, TimeSpan? connectTimeout = null, TimeSpan? finishTimeout = null) =>
        new(grok ? new GrokStreamingProtocol("test-only", []) : new GatewayStreamingProtocol("test-only"), metrics, token,
            () => socket, queueLimit, connectTimeout, finishTimeout);
    private static async Task ExpectFailure(Task<string> task)
    {
        try { await task.WaitAsync(TimeSpan.FromSeconds(3)); throw new Exception("Expected streaming failure"); }
        catch (Exception ex) when (ex is HttpRequestException or InvalidDataException or TimeoutException) { }
    }
    private sealed class FakeTransport(bool grok) : IStreamingTransport
    {
        private readonly Channel<string> events = Channel.CreateUnbounded<string>();
        internal string Mode { get; init; } = "finish";
        internal bool BlockConnect { get; init; }
        internal Uri? Uri;
        internal string[] Protocols = [];
        internal readonly List<byte[]> Pcm = [];
        internal readonly List<string> TextFrames = [];
        internal int DoneCount;
        internal bool Disposed;
        internal TaskCompletionSource FirstAudio = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public async Task ConnectAsync(Uri uri, IReadOnlyDictionary<string, string> headers, IReadOnlyList<string> protocols, CancellationToken token)
        {
            Uri = uri; Protocols = protocols.ToArray();
            if (BlockConnect) await Task.Delay(Timeout.Infinite, token);
            if (grok) events.Writer.TryWrite("{\"type\":\"transcript.created\"}");
            if (Mode == "early") events.Writer.TryWrite("{\"type\":\"finish\",\"text\":\"Too early\"}");
        }
        public Task SendAsync(ReadOnlyMemory<byte> bytes, bool text, CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            if (!text)
            {
                Pcm.Add(bytes.ToArray());
                FirstAudio.TrySetResult();
                if (Pcm.Count == 1) events.Writer.TryWrite(grok
                    ? "{\"type\":\"transcript.partial\",\"text\":\"Hello\",\"is_final\":true}"
                    : "{\"type\":\"transcript-partial\",\"text\":\"Incorrect provisional text\"}");
                return Task.CompletedTask;
            }
            var value = Encoding.UTF8.GetString(bytes.Span); TextFrames.Add(value);
            if (!value.Contains("done")) return Task.CompletedTask;
            DoneCount++;
            if (Mode == "error") events.Writer.TryWrite("{\"type\":\"error\",\"error\":\"test-only credential must not leak\"}");
            else if (Mode == "close") events.Writer.TryComplete();
            else if (Mode == "finish") events.Writer.TryWrite(grok
                ? "{\"type\":\"transcript.done\",\"text\":\"world.\"}"
                : "{\"type\":\"finish\",\"text\":\"Hello world.\",\"segments\":[]}");
            return Task.CompletedTask;
        }
        public async Task<JsonDocument> ReceiveAsync(CancellationToken token)
        {
            try { return JsonDocument.Parse(await events.Reader.ReadAsync(token)); }
            catch (ChannelClosedException) { throw new HttpRequestException("Socket closed before finish."); }
        }
        public void Dispose() { Disposed = true; events.Writer.TryComplete(); }
    }
}
