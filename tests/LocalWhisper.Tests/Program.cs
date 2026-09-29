using System.Net;
using System.Text;
using System.Text.Json;
using LocalWhisper;
using System.Runtime.InteropServices;

internal static class Program
{
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(nint window);
    private static int count;
    [STAThread]
    private static void Main(string[] args)
    {
        try
        {
            if (args.Contains("--benchmark")) { Benchmark().GetAwaiter().GetResult(); return; }
            if (args.Contains("--mai-pause-benchmark")) { MaiPauseBenchmark.RunAsync().GetAwaiter().GetResult(); return; }
            if (args.Contains("--mai-dual-benchmark")) { MaiDualBenchmark.RunAsync(args).GetAwaiter().GetResult(); return; }
            if (args.Contains("--credits"))
            {
                using var http = new HttpClient();
                var balance = new Credits(http).GetAsync(Settings.LoadKey()).GetAwaiter().GetResult();
                Console.WriteLine($"kind={balance.Kind} usageAvailable={balance.Usage.HasValue} remainingAvailable={balance.Remaining.HasValue}");
                return;
            }
            Gestures();
            Api().GetAwaiter().GetResult();
            ParallelChecks().GetAwaiter().GetResult();
            Fallback().GetAwaiter().GetResult();
            XaiContract().GetAwaiter().GetResult();
            CleanupChecks.RunAsync(Check).GetAwaiter().GetResult();
            VocabularyChecks.RunAsync(Check).GetAwaiter().GetResult();
            CorrectionLearningChecks();
            PauseSplitting();
            Pipeline().GetAwaiter().GetResult();
            CreditChecks().GetAwaiter().GetResult();
            if (args.Contains("--desktop")) Desktop();
            Console.WriteLine($"PASS: {count} checks");
        }
        catch (Exception ex) { Console.Error.WriteLine(ex); Environment.ExitCode = 1; }
    }
    private static async Task CreditChecks()
    {
        foreach (var kind in new[] { "account", "key", "unavailable" })
        {
            using var http = new HttpClient(new Handler((request, _) =>
            {
                var key = request.RequestUri!.AbsolutePath.EndsWith("/key");
                if (!key && kind != "account") return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden));
                var body = key ? "{\"data\":{\"usage\":1.5,\"usage_daily\":0.2,\"usage_monthly\":1.0,\"limit_remaining\":" + (kind == "key" ? "8.5" : "null") + "}}" : "{\"data\":{\"total_credits\":100,\"total_usage\":25}}";
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body) });
            }));
            var result = await new Credits(http).GetAsync("test-only");
            Check(result.Kind == kind, "Account balance and key allowance stay distinct");
            Check(result.Usage == 1.5m && result.UsageDaily == .2m, "Existing key usage is retained when balance is forbidden");
            Check(result.Remaining == (kind == "account" ? 75m : kind == "key" ? 8.5m : (decimal?)null), "An unlimited key is not treated as an account balance");
        }
        using var activityHttp = new HttpClient(new Handler((request, _) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            var content = path switch
            {
                "/api/v1/key" => "{\"data\":{\"label\":\"sk-or-v1-abc...xyz\",\"usage\":0.5}}",
                "/api/v1/keys" => "{\"data\":[{\"label\":\"sk-or-v1-abc...xyz\",\"hash\":\"key-hash\"}]}",
                "/api/v1/activity" => "{\"data\":[{\"date\":\"2026-09-15\",\"model\":\"microsoft/mai-transcribe-2\",\"provider_name\":\"Azure\",\"endpoint_id\":\"ep-1\",\"requests\":4,\"usage\":0.012},{\"date\":\"2026-09-15\",\"model\":\"openai/gpt-6-luna\",\"provider_name\":\"OpenAI\",\"endpoint_id\":\"ep-2\",\"requests\":2,\"usage\":0.003},{\"date\":\"2026-09-15\",\"model\":\"google/gemini-3.8-flash\",\"provider_name\":\"Google\",\"endpoint_id\":\"ep-3\",\"requests\":1,\"usage\":0.002},{\"date\":\"2026-09-15\",\"model\":\"other/model\",\"usage\":4}]}",
                _ => throw new Exception($"Unexpected credit endpoint: {path}")
            };
            Check(request.Headers.Authorization?.Parameter == (path == "/api/v1/key" ? "inference-key" : "management-key"), "Activity import uses each key only for its intended endpoint");
            if (path == "/api/v1/activity") Check(request.RequestUri.Query.Contains("api_key_hash=key-hash"), "Activity is filtered to the dictation API key");
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(content) });
        }));
        var activity = await new Credits(activityHttp).ImportActivityAsync("inference-key", "management-key");
        Check(activity.Rows is [{ Category: "voice", Model: Transcriber.MaiModel, Amount: 0.012m, Requests: 4 }, { Category: "cleanup", Model: CleanupService.Model, Amount: 0.003m, Requests: 2 }, { Category: "voice", Model: "google/gemini-3.8-flash", Amount: 0.002m, Requests: 1 }], "Activity preserves historical voice and Luna costs");
        Check(activity.Rows[0].Provider == "Azure" && activity.Rows[0].Endpoint == "ep-1", "Activity keeps the provider endpoint breakdown");
        Check(activity.Through == DateTime.UtcNow.Date.AddDays(-1), "Activity stops at the last completed UTC day");
    }
    private static void CorrectionLearningChecks()
    {
        Check(CorrectionLearning.TryLocatePastedText("\n\n", "Zetasizer, Nanosite, Ares.\n", "Zetasizer, Nanosite, Ares.", out var left, out var right)
            && left == "" && right == "\n", "Paste verification locates text when the editor changes its surrounding newlines");
        Check(!CorrectionLearning.TryLocatePastedText("Ares.", "Ares. Ares.", "Ares.", out _, out _), "Paste verification rejects text that was already present");
        Check(CorrectionLearning.Candidate("The Roghage is here.", "The Raikage is here.") == "Raikage", "A changed word produces the full preferred spelling");
        Check(CorrectionLearning.Candidate("Meet astra tomorrow.", "Meet Astra tomorrow.") == "Astra", "A capitalization correction can teach a preferred spelling");
        Check(CorrectionLearning.Candidate("Roghage", "Rogh") is null, "Partial deletion does not create a learned word");
        Check(CorrectionLearning.Candidate("The Roghage is here.", "The Roghage is here. Also") is null, "Appended typing is not learned");
        Check(CorrectionLearning.Candidate("Meet at five.", "Meet at six.") is null, "Numbers and dates are not learned as spelling corrections");
        Check(CorrectionLearning.Candidate("Roghage is here.", "Raikage was here.") is null, "Two changed words are not learned");
        Check(CorrectionLearning.Candidate("one two", "one two three") is null, "Inserted words are not learned");
        Check(CorrectionLearning.CandidateTerms("Zetasizer, Nanosite, Ares.", "Zetasizer, NanoSight, Aeris").SequenceEqual(["NanoSight", "Aeris"]), "Two independent corrections are learned even when final punctuation changes");
        Check(CorrectionLearning.CandidateTerms("I used a Rasengon.", "I used a Rasengan.").SequenceEqual(["Rasengan"]), "A single name correction is learned");
        Check(CorrectionLearning.CandidateTerms("Zetasizer, Nanosite, Ares.", "Zetasizer, Nanosite, Ares").Length == 0, "Punctuation edits alone do not add a term");
        var tracker = new CorrectionLearning.Tracker("Zetasizer, Nanosite, Ares.");
        Check(tracker.Observe("Zetasizer, NanoSight, Ares.", 0).Length == 0, "A fresh edit is not learned yet");
        Check(tracker.Observe("Zetasizer, NanoSight, Ares.", 2500).SequenceEqual([new CorrectionLearning.CorrectionUpdate(1, null, "NanoSight")]), "The first settled correction is learned");
        Check(tracker.Observe("Zetasizer, NanoSight, Aeris", 2600).Length == 0, "The second edit is not learned while being typed");
        Check(tracker.Observe("Zetasizer, NanoSight, Aeris", 5100).SequenceEqual([new CorrectionLearning.CorrectionUpdate(2, null, "Aeris")]), "A later correction is learned without notifying twice for the first");
        var partial = new CorrectionLearning.Tracker("Nanosite");
        Check(partial.Observe("nanor", 0).Length == 0 && partial.Observe("nanos", 600).Length == 0
            && partial.Observe("nanosi", 1200).Length == 0 && partial.Observe("nanosig", 1800).Length == 0
            && partial.Observe("nanosigh", 2400).Length == 0 && partial.Observe("nanosight", 3000).Length == 0
            && partial.Observe("nanosight", 5500).SequenceEqual([new CorrectionLearning.CorrectionUpdate(0, null, "nanosight")]),
            "Letter-by-letter correction saves only the settled spelling");
        var revised = new CorrectionLearning.Tracker("Nanosite");
        revised.Observe("nanor", 0);
        Check(revised.Observe("nanor", 2500).SequenceEqual([new CorrectionLearning.CorrectionUpdate(0, null, "nanor")]), "A long pause can produce a provisional spelling");
        revised.Observe("NanoSight", 3000);
        Check(revised.Observe("NanoSight", 5500).SequenceEqual([new CorrectionLearning.CorrectionUpdate(0, "nanor", "NanoSight")]), "A later revision replaces the provisional spelling");
        var sent = new CorrectionLearning.Tracker("Nanosite");
        Check(sent.Observe("NanoSight", 0).Length == 0
            && sent.Commit("NanoSight").SequenceEqual([new CorrectionLearning.CorrectionUpdate(0, null, "NanoSight")]),
            "A corrected word can be learned when the composer clears before the settle delay");
    }
    private static async Task Fallback()
    {
        var attempted = new List<string>();
        var fallback = new ModelTranscription(
            (model, _, _, _, _) =>
            {
                attempted.Add(model);
                if (model == TranscriptionModels.MaiClean)
                    throw new HttpRequestException("Provider unavailable", null, HttpStatusCode.ServiceUnavailable);
                return Task.FromResult("Recovered by GPT");
            },
            model => model != TranscriptionModels.GrokStreaming);
        var fallbackMetrics = new SessionMetrics();
        var result = await fallback.TranscribeWithFallbackAsync([1, 2, 3], "wav", TranscriptionModels.MaiClean, [], fallbackMetrics, default);
        Check(result.Text == "Recovered by GPT" && result.UsedModel == TranscriptionModels.Gpt, "A transient primary-model failure falls back to a different model");
        Check(attempted.SequenceEqual([TranscriptionModels.MaiClean, TranscriptionModels.Gpt]), "Fallback follows the requested model's configured order");
        var fallbackSnapshot = fallbackMetrics.Snapshot();
        Check(fallbackSnapshot.RequestedTranscriptionModel == TranscriptionModels.MaiClean
            && fallbackSnapshot.TranscriptionModel == TranscriptionModels.Gpt
            && fallbackSnapshot.Fallbacks is [{ Model: TranscriptionModels.MaiClean }], "Fallback metrics report the requested model, successful model, and failed attempt");

        attempted.Clear();
        var emptyPrimary = new ModelTranscription(
            (model, _, _, _, _) => { attempted.Add(model); return Task.FromResult(model == TranscriptionModels.MaiClean ? "" : "Recovered empty result"); },
            model => model != TranscriptionModels.GrokStreaming);
        Check((await emptyPrimary.TranscribeWithFallbackAsync([1], "wav", TranscriptionModels.MaiClean, [], new SessionMetrics(), default)).Text == "Recovered empty result",
            "An empty provider result falls back instead of being treated as no speech");

        attempted.Clear();
        var rejectedRequest = new ModelTranscription(
            (model, _, _, _, _) =>
            {
                attempted.Add(model);
                if (model == TranscriptionModels.MaiClean)
                    throw new HttpRequestException("Provider returned 400", null, HttpStatusCode.BadRequest);
                return Task.FromResult("Recovered rejected request");
            }, model => model != TranscriptionModels.GrokStreaming);
        var rejectedMetrics = new SessionMetrics();
        var rejectedResult = await rejectedRequest.TranscribeWithFallbackAsync([1], "wav", TranscriptionModels.MaiClean, [], rejectedMetrics, default);
        Check(rejectedResult.Text == "Recovered rejected request"
            && rejectedResult.FailedAttempts is [{ Model: TranscriptionModels.MaiClean, Error: "Provider returned 400" }]
            && rejectedMetrics.Snapshot().Fallbacks is [{ Model: TranscriptionModels.MaiClean, Error: "Provider returned 400" }]
            && attempted.SequenceEqual([TranscriptionModels.MaiClean, TranscriptionModels.Gpt]),
            "A provider 400 is reported and falls back to another model");

        attempted.Clear();
        var authFailure = new ModelTranscription(
            (model, _, _, _, _) =>
            {
                attempted.Add(model);
                if (model != TranscriptionModels.GrokStreaming)
                    throw new HttpRequestException("Rejected key", null, HttpStatusCode.Unauthorized);
                return Task.FromResult("Recovered with separate provider credentials");
            }, _ => true);
        var authResult = await authFailure.TranscribeWithFallbackAsync([1], "wav", TranscriptionModels.MaiClean, [], new SessionMetrics(), default);
        Check(authResult.Text == "Recovered with separate provider credentials"
            && attempted.SequenceEqual([TranscriptionModels.MaiClean, TranscriptionModels.Gpt, TranscriptionModels.GrokStreaming]),
            "Authentication failures fall through to models with separate provider credentials");

        attempted.Clear();
        var noGrokKey = new ModelTranscription(
            (model, _, _, _, _) => { attempted.Add(model); throw new InvalidDataException("Malformed provider response"); },
            model => model != TranscriptionModels.GrokStreaming);
        try { await noGrokKey.TranscribeWithFallbackAsync([1], "wav", TranscriptionModels.Gpt, [], new SessionMetrics(), default); throw new Exception("Expected exhausted fallback"); }
        catch (AggregateException) { Check(attempted.SequenceEqual([TranscriptionModels.Gpt, TranscriptionModels.MaiClean]), "Unavailable providers are skipped in the fallback chain"); }

        Check(ModelTranscription.FallbackOrder(TranscriptionModels.GrokStreaming).SequenceEqual([
            TranscriptionModels.GrokStreaming, TranscriptionModels.MaiClean, TranscriptionModels.Gpt
        ]), "Grok falls back through MAI Clean and GPT");

        attempted.Clear();
        var exact = new ModelTranscription(
            (model, _, _, _, _) => { attempted.Add(model); return Task.FromResult("Comparison"); },
            _ => true);
        var comparison = await exact.TranscribeExactAsync([1], "wav", TranscriptionModels.MaiVerbatim, [], new SessionMetrics(), default);
        Check(comparison.Text == "Comparison" && attempted.SequenceEqual([TranscriptionModels.MaiVerbatim]), "Alternate transcription runs only the selected comparison model");
    }
    private static void PauseSplitting()
    {
        var chunks = new PauseChunks();
        var speech = new byte[32000 * 7]; Array.Fill<byte>(speech, 7);
        Check(chunks.Add(speech, speech.Length, .5f) is null, "Continuous speech is not cut mid-word");
        var pause = new byte[16000];
        var result = chunks.Add(pause, pause.Length, 0);
        Check(result is not null && result.Length == speech.Length + pause.Length, "Pause emits complete PCM without loss");
        Check(result!.Take(speech.Length).SequenceEqual(speech), "Speech bytes preserved at boundary");
        Check(chunks.Drain().Length == 0, "Emitted audio is not sent again");
        Check(chunks.Add(pause, pause.Length, 0) is null, "Short pauses do not emit tiny chunks");
        Check(chunks.Drain().SequenceEqual(pause), "Finish includes final tail exactly once");
    }
    private static async Task Pipeline()
    {
        static byte[] Pcm(int seconds)
        {
            var pcm = new byte[seconds * 32000];
            for (var i = 0; i < pcm.Length / 2; i++) BitConverter.TryWriteBytes(pcm.AsSpan(i * 2, 2), (short)(8000 * Math.Sin(i * .1)));
            return pcm;
        }
        using var http = new HttpClient(new Handler(async (request, token) =>
        {
            using var json = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            var audio = json.RootElement.GetProperty("input_audio");
            Check(audio.GetProperty("format").GetString() == "mp3", "Pipeline uses compressed audio at native microphone rate");
            var size = Convert.FromBase64String(audio.GetProperty("data").GetString()!).Length;
            var first = size < 10000;
            await Task.Delay(first ? 180 : 10, token);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(first ? "{\"text\":\"first\"}" : "{\"text\":\"second\"}") };
        }));
        var trace = new SessionMetrics();
        var session = new TranscriptionSession(http, "test-only", trace, default);
        session.EnqueuePcm(Pcm(1)); session.EnqueuePcm(Pcm(2));
        var watch = System.Diagnostics.Stopwatch.StartNew();
        while (session.Completed == 0 && watch.ElapsedMilliseconds < 3000) await Task.Delay(10);
        Check(session.Completed > 0, "Transcription starts before Finish is called");
        Check(await session.FinishAsync() == "first second", "Out-of-order responses are assembled in recording order");
        Check(trace.Snapshot().Rows.All(r => !r.Running), "Completed requests leave no stuck timing rows");
        Check(trace.Snapshot().RequestBytes > 0, "Request size is measured");
        var mixedCalls = 0;
        using var mixed = new HttpClient(new Handler((_, _) =>
        {
            var n = Interlocked.Increment(ref mixedCalls);
            if (n % 2 == 1) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.BadRequest));
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"text\":\"kept\"}") });
        }));
        var partial = new TranscriptionSession(mixed, "test-only", new SessionMetrics(), default);
        partial.EnqueuePcm(Pcm(1)); partial.EnqueuePcm(Pcm(2));
        Check(await partial.FinishAsync() == "kept", "A failed chunk keeps the successful chunks instead of losing the recording");
        Check(partial.Failed == 1 && partial.Completed == 1, "Failed chunks are counted separately from completed ones");
        using var alwaysFail = new HttpClient(new Handler((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.Unauthorized))));
        var doomed = new TranscriptionSession(alwaysFail, "test-only", new SessionMetrics(), default);
        doomed.EnqueuePcm(Pcm(1));
        try { await doomed.FinishAsync(); throw new Exception("Expected persistent transcription failure"); }
        catch (HttpRequestException) { Check(doomed.Failed == 1, "A fully failed recording reports its failed chunks"); }
        using var cancellation = new CancellationTokenSource();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var blocked = new HttpClient(new Handler(async (_, token) =>
        {
            started.SetResult(); await Task.Delay(Timeout.Infinite, token);
            return new HttpResponseMessage(HttpStatusCode.OK);
        }));
        var pending = new TranscriptionSession(blocked, "test-only", new SessionMetrics(), cancellation.Token);
        pending.EnqueuePcm(Pcm(1));
        await started.Task.WaitAsync(TimeSpan.FromSeconds(3)); cancellation.Cancel();
        try { await pending.FinishAsync(); throw new Exception("Expected pipeline cancellation"); }
        catch (OperationCanceledException) { Check(true, "Cancel aborts in-flight chunks without returning partial text"); }
    }
    private static async Task Benchmark()
    {
        Directory.CreateDirectory("artifacts");
        var path = Path.GetFullPath("artifacts/benchmark-speech.wav");
        dynamic voice = Activator.CreateInstance(Type.GetTypeFromProgID("SAPI.SpVoice")!)!;
        dynamic stream = Activator.CreateInstance(Type.GetTypeFromProgID("SAPI.SpFileStream")!)!;
        stream.Format.Type = 22; // 22.05 kHz, 16-bit mono
        stream.Open(path, 3, false); voice.AudioOutputStream = stream;
        voice.Speak("This is a performance test for local dictation. We want the words to appear quickly after recording stops.");
        stream.Close();
        Marshal.FinalReleaseComObject(stream); Marshal.FinalReleaseComObject(voice);
        using var reader = new NAudio.Wave.WaveFileReader(path);
        var pcm = new byte[reader.Length]; reader.ReadExactly(pcm);
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        var key = Settings.LoadKey();
        foreach (var repeat in new[] { 1, 4 })
        {
            using var buffer = new MemoryStream();
            using (var writer = new NAudio.Wave.WaveFileWriter(new NAudio.Utils.IgnoreDisposeStream(buffer), reader.WaveFormat))
                for (var i = 0; i < repeat; i++) writer.Write(pcm, 0, pcm.Length);
            var watch = System.Diagnostics.Stopwatch.StartNew();
            var metrics = new SessionMetrics();
            (byte[] Bytes, string Format) encoded;
            using (metrics.Measure("Compress audio")) encoded = AudioEncoding.Compress(buffer.ToArray());
            Console.WriteLine($"payload={encoded.Bytes.Length} bytes format={encoded.Format}");
            var pending = new Transcriber(http).TranscribeAsync(encoded.Bytes, key, default, metrics, format: encoded.Format);
            var synchronousMs = watch.Elapsed.TotalMilliseconds;
            var result = await pending;
            Console.WriteLine($"audio={reader.TotalTime.TotalSeconds * repeat:F1}s total={watch.Elapsed.TotalSeconds:F3}s synchronous={synchronousMs:F1}ms chars={result.Length} under3s={watch.Elapsed.TotalSeconds < 3}");
            foreach (var row in metrics.Snapshot().Rows) Console.WriteLine($"  {row.Name}: {row.DurationMs:F1}ms");
        }
    }
    private static void Check(bool condition, string description)
    {
        if (!condition) throw new Exception(description);
        count++;
    }
    private static void Gestures()
    {
        var g = new Gesture();
        Check(g.Press(0) == GestureAction.Start, "Press starts capture");
        Check(g.Press(100) == GestureAction.None, "Repeated keydown does not restart");
        Check(g.Release(800) == GestureAction.Finish, "Long hold finishes on release");
        Check(g.Press(900) == GestureAction.None, "Busy ignores shortcut");
        Check(g.Finish() == GestureAction.None, "Repeated finish is ignored");
        g.Reset();
        g.Press(1000); g.Release(1100);
        Check(g.Mode == CaptureMode.WaitingForTap, "Short tap waits for second press");
        Check(g.Tick(1450) == GestureAction.None, "Double-tap boundary is inclusive");
        Check(g.Press(1450) == GestureAction.None && g.Mode == CaptureMode.LockMode, "Second tap enters lock mode");
        Check(g.Release(1500) == GestureAction.None && g.Mode == CaptureMode.LockMode, "Release keeps lock mode recording alive");
        Check(g.Tick(60000) == GestureAction.None, "Locked capture does not finish on timer");
        Check(g.Press(61000) == GestureAction.Finish, "Next press finishes locked capture");
        g.Reset(); g.Press(0); g.Release(100);
        Check(g.Tick(451) == GestureAction.Finish, "Single tap eventually submits");
        g.Reset(); g.Press(0); g.Release(100);
        Check(g.Press(451) == GestureAction.Finish, "Late tap cannot lock");
        var lockedByDefault = new Gesture(true);
        Check(lockedByDefault.Press(0) == GestureAction.Start && lockedByDefault.Mode == CaptureMode.LockMode, "Lock mode starts directly in lock mode");
        Check(lockedByDefault.Release(100) == GestureAction.None && lockedByDefault.Mode == CaptureMode.LockMode, "Lock mode ignores shortcut release");
        Check(lockedByDefault.Press(200) == GestureAction.Finish, "Shortcut accepts a lock-mode recording");
        g.Reset(); g.Press(0); g.Reset();
        Check(g.Release(200) == GestureAction.None && g.Tick(1000) == GestureAction.None, "Cancelled capture cannot submit on release");
        g.Press(0); g.Release(100); g.Press(200);
        Check(g.Finish() == GestureAction.Finish, "Toolbar finish works for locked recording");
    }
    private static async Task Api()
    {
        using var http = new HttpClient(new Handler(async (request, token) =>
        {
            Check(request.RequestUri!.ToString() == "https://openrouter.ai/api/v1/audio/transcriptions", "Correct endpoint");
            Check(request.Headers.Authorization?.Parameter == "test-only", "Key sent as bearer token");
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            Check(body.RootElement.GetProperty("model").GetString() == Transcriber.MaiModel, "Default uses the MAI model");
            var style = body.RootElement.GetProperty("provider").GetProperty("options").GetProperty("azure")
                .GetProperty("enhancedMode").GetProperty("modelOptions").GetProperty("transcribeStyle").GetString();
            Check(style == "clean", "Default uses MAI Clean transcription");
            Check(body.RootElement.GetProperty("input_audio").GetProperty("format").GetString() == "wav", "WAV format");
            Check(Convert.FromBase64String(body.RootElement.GetProperty("input_audio").GetProperty("data").GetString()!).SequenceEqual(new byte[] { 1, 2, 3 }), "Audio survives base64 encoding");
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"text\":\"  Hello, ä¸–ç•Œ!  \",\"usage\":{\"cost\":0.00042}}", Encoding.UTF8, "application/json") };
        }));
        var apiMetrics = new SessionMetrics();
        Check(await new Transcriber(http).TranscribeAsync([1, 2, 3], "test-only", default, apiMetrics) == "Hello, ä¸–ç•Œ!", "Unicode transcript preserved");
        Check(apiMetrics.Snapshot().Costs is [{ Category: "voice", Model: Transcriber.MaiModel, Amount: 0.00042m }], "Transcription records provider cost against the voice model");
        foreach (var status in new[] { 401, 402, 429, 500 })
        {
            using var failed = new HttpClient(new Handler((_, _) => Task.FromResult(new HttpResponseMessage((HttpStatusCode)status))));
            try { await new Transcriber(failed) { RetryBackoff = _ => TimeSpan.Zero }.TranscribeAsync([0], "test-only", default); throw new Exception("Expected API error"); }
            catch (HttpRequestException ex) { Check(!ex.Message.Contains("test-only"), "API errors do not expose key"); }
        }
        var flakyCalls = 0;
        using var flaky = new HttpClient(new Handler((_, _) =>
        {
            if (Interlocked.Increment(ref flakyCalls) <= 2)
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.TooManyRequests) { Content = new StringContent("{\"error\":{\"message\":\"No servers available\"}}") });
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"text\":\"Recovered\"}") });
        }));
        Check(await new Transcriber(flaky) { RetryBackoff = _ => TimeSpan.Zero }.TranscribeAsync([1], "test-only", default) == "Recovered", "Transient rate limits are retried without losing the recording");
        Check(flakyCalls == 3, "Two throttled tries precede the successful transcription");
        var emptyCalls = 0;
        using var empty = new HttpClient(new Handler((_, _) =>
        {
            Interlocked.Increment(ref emptyCalls);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"text\":\"\"}") });
        }));
        try { await new Transcriber(empty) { RetryBackoff = _ => TimeSpan.Zero, HedgeDelay = _ => TimeSpan.Zero }.TranscribeAsync([0], "test-only", default); throw new Exception("Expected empty transcript failure"); }
        catch (HttpRequestException) { Check(emptyCalls == 3, "An empty transcript is retried before cross-model fallback"); }
        var immediateCalls = 0;
        using var rejected = new HttpClient(new Handler((_, _) =>
        {
            Interlocked.Increment(ref immediateCalls);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Unauthorized));
        }));
        try { await new Transcriber(rejected) { RetryBackoff = _ => TimeSpan.Zero }.TranscribeAsync([0], "test-only", default); throw new Exception("Expected auth error"); }
        catch (HttpRequestException) { Check(immediateCalls == 1, "Rejected keys fail fast without retries"); }
        Check(Transcriber.IsRetryableStatus(HttpStatusCode.TooManyRequests) && Transcriber.IsRetryableStatus(HttpStatusCode.ServiceUnavailable), "Rate limits and outages are retryable");
        Check(!Transcriber.IsRetryableStatus(HttpStatusCode.Unauthorized) && !Transcriber.IsRetryableStatus(HttpStatusCode.PaymentRequired), "Auth and credit errors are not retried");
        using var malformed = new HttpClient(new Handler((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{}") })));
        try { await new Transcriber(malformed).TranscribeAsync([0], "test-only", default); throw new Exception("Expected malformed response error"); }
        catch (InvalidDataException) { Check(true, "Missing text is rejected"); }
        using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
        try { await new Transcriber(http).TranscribeAsync([0], "test-only", cancelled.Token); throw new Exception("Expected cancellation"); }
        catch (OperationCanceledException) { Check(true, "Cancelled requests abort"); }
        Check(Transcriber.DefaultHedgeDelay(0) == TimeSpan.FromMilliseconds(2500), "Hedge floor is 2.5s");
        Check(Transcriber.DefaultHedgeDelay(15) == TimeSpan.FromMilliseconds(3250), "Hedge cutoff scales with audio length");
        Check(Transcriber.DefaultHedgeDelay(3600) == TimeSpan.FromSeconds(10), "Hedge cutoff is capped");
        Check(Math.Abs(Transcriber.EstimateAudioSeconds(new byte[6000], "mp3") - 1.0) < 0.001, "MP3 duration falls back to bitrate estimate");
        var wavHeader = new byte[44 + 32000];
        wavHeader[0] = (byte)'R'; wavHeader[1] = (byte)'I'; wavHeader[2] = (byte)'F'; wavHeader[3] = (byte)'F';
        BitConverter.GetBytes(32036).CopyTo(wavHeader, 4);
        "WAVEfmt ".ToCharArray().Select(c => (byte)c).ToArray().CopyTo(wavHeader, 8);
        BitConverter.GetBytes(16).CopyTo(wavHeader, 16);
        BitConverter.GetBytes((short)1).CopyTo(wavHeader, 20);
        BitConverter.GetBytes((short)1).CopyTo(wavHeader, 22);
        BitConverter.GetBytes(16000).CopyTo(wavHeader, 24);
        BitConverter.GetBytes(32000).CopyTo(wavHeader, 28);
        "data".ToCharArray().Select(c => (byte)c).ToArray().CopyTo(wavHeader, 36);
        BitConverter.GetBytes(32000).CopyTo(wavHeader, 40);
        Check(Math.Abs(Transcriber.EstimateAudioSeconds(wavHeader, "wav") - 1.0) < 0.001, "WAV duration parses from header");
        var attempts = 0;
        using var stalled = new HttpClient(new Handler(async (_, token) =>
        {
            if (Interlocked.Increment(ref attempts) == 1) await Task.Delay(TimeSpan.FromMilliseconds(150), token);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"text\":\"Hedged\"}") };
        }));
        var hedged = new Transcriber(stalled) { HedgeDelay = _ => TimeSpan.FromMilliseconds(50) };
        var hedgeMetrics = new SessionMetrics();
        Check(await hedged.TranscribeAsync([1, 2, 3], "test-only", default, hedgeMetrics) == "Hedged", "Stalled first attempt loses to hedge");
        Check(attempts == 2, "Hedge fires exactly one second request");
        await hedgeMetrics.WaitForBackgroundAsync();
        var hedge = hedgeMetrics.Snapshot().Hedges;
        Check(hedge is [{ WinnerAttempt: 2, SavedMs: > 0 }], "Hedge records the winner and completed loser");
        Check(hedge[0].CutoffMs == 50 && hedge[0].WinnerMs >= 0 && hedge[0].LoserMs >= 150, "Hedge durations cover both attempts");
        Check(hedgeMetrics.Snapshot().Requests.Length == 2, "Both hedge request durations are recorded");
        var fastCalls = 0;
        using var fast = new HttpClient(new Handler((_, _) =>
        {
            Interlocked.Increment(ref fastCalls);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"text\":\"Prompt\"}") });
        }));
        Check(await new Transcriber(fast) { HedgeDelay = _ => TimeSpan.FromMilliseconds(50) }.TranscribeAsync([1], "test-only", default, apiMetrics) == "Prompt", "Fast attempt returns without hedging");
        Check(fastCalls == 1, "No second request when first is prompt");
        Check(apiMetrics.Snapshot().Hedges.Length == 0, "Prompt requests record no hedge");
    }
    private static async Task ParallelChecks()
    {
        var maiCalls = 0;
        var gptCalls = 0;
        using var http = new HttpClient(new Handler(async (request, token) =>
        {
            using var payload = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            var model = payload.RootElement.GetProperty("model").GetString();
            if (model == Transcriber.MaiModel)
            {
                var number = Interlocked.Increment(ref maiCalls);
                await Task.Delay(number == 1 ? 150 : 20, token);
            }
            else Interlocked.Increment(ref gptCalls);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"text\":\"Winner\",\"usage\":{\"cost\":0.001}}") };
        }));
        var metrics = new SessionMetrics();
        var transcriber = new Transcriber(http) { ParallelFallbackDelay = _ => TimeSpan.FromMilliseconds(300) };
        Check(await transcriber.TranscribeAsync([1, 2], "test-only", default, metrics,
            doubleTranscription: true) == "Winner", "Immediate MAI race returns the first success");
        await metrics.WaitForBackgroundAsync();
        var snapshot = metrics.Snapshot();
        Check(maiCalls == 2 && gptCalls == 0, "Race starts two MAI requests without an unnecessary fallback");
        Check(snapshot.ParallelRequests.Length == 2 && snapshot.ParallelRequests.Single(x => x.Selected).Attempt == 2
            && snapshot.ParallelRequests.Single(x => x.Attempt == 1).DurationMs >= 140,
            "The slower MAI request finishes and its full duration is recorded");
        Check(snapshot.Costs.Length == 2 && snapshot.Requests.Length == 2, "Both MAI costs and request times are retained");

        var slowMai = 0;
        var fallbackCalls = 0;
        using var fallbackHttp = new HttpClient(new Handler(async (request, token) =>
        {
            using var payload = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            if (payload.RootElement.GetProperty("model").GetString() == Transcriber.MaiModel)
            { Interlocked.Increment(ref slowMai); await Task.Delay(160, token); }
            else { Interlocked.Increment(ref fallbackCalls); await Task.Delay(10, token); }
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"text\":\"Fallback\"}") };
        }));
        var fallbackMetrics = new SessionMetrics();
        Check(await new Transcriber(fallbackHttp) { ParallelFallbackDelay = _ => TimeSpan.FromMilliseconds(30) }
            .TranscribeAsync([1], "test-only", default, fallbackMetrics, doubleTranscription: true) == "Fallback",
            "GPT can win when both MAI requests are slow");
        await fallbackMetrics.WaitForBackgroundAsync();
        var fallbackSnapshot = fallbackMetrics.Snapshot();
        Check(slowMai == 2 && fallbackCalls == 1 && fallbackSnapshot.TranscriptionModel == TranscriptionModels.Gpt,
            "Slow double MAI triggers one GPT fallback and records the used model");
        Check(fallbackSnapshot.ParallelRequests.Length == 3 && fallbackSnapshot.Requests.Length == 3,
            "Fallback and both slower MAI requests retain their full timings");
    }
    private static async Task XaiContract()
    {
        Check(TranscriptionModels.IsValid(TranscriptionModels.GrokStreaming)
            && TranscriptionModels.IsStreaming(TranscriptionModels.GrokStreaming), "Grok streaming is a selectable streaming model");
        var uri = XaiTranscription.StreamingUri(["Hashirama", "Sea of Storms"]);
        Check(uri.Scheme == "wss" && uri.Host == "api.x.ai" && uri.AbsolutePath == "/v1/stt", "Grok streaming uses the direct xAI WebSocket");
        Check(uri.Query.Contains("model=grok-voice-transcribe-2.0") && uri.Query.Contains("sample_rate=16000")
            && uri.Query.Contains("encoding=pcm") && uri.Query.Contains("keyterm=Hashirama")
            && uri.Query.Contains("keyterm=Sea%20of%20Storms"), "Streaming configuration includes PCM format and every dictionary keyterm");
        var source = new[] { Enumerable.Repeat((byte)1, 1280).ToArray(), Enumerable.Repeat((byte)2, 1280).ToArray(), Enumerable.Repeat((byte)3, 1280).ToArray() };
        var frames = XaiTranscription.Frames(source).ToArray();
        Check(frames.Length == 2 && frames[0].Length == 3200 && frames[1].Length == 640, "Forty-millisecond capture buffers are repacked into 100ms streaming frames without dropping the tail");
        Check(frames.SelectMany(frame => frame).SequenceEqual(source.SelectMany(chunk => chunk)), "Streaming frame conversion preserves every PCM byte in order");
        try { XaiTranscription.ValidateKeyterms(Enumerable.Repeat("term", 101).ToArray()); throw new Exception("Expected keyterm limit"); }
        catch (InvalidOperationException) { Check(true, "Grok dictionary rejects more than 100 keyterms instead of silently dropping biasing"); }
        try { XaiTranscription.ValidateKeyterms([new string('x', 51)]); throw new Exception("Expected keyterm length limit"); }
        catch (InvalidOperationException) { Check(true, "Grok dictionary rejects overlong keyterms instead of silently changing biasing"); }

        using var http = new HttpClient(new Handler(async (request, token) =>
        {
            Check(request.RequestUri!.ToString() == "https://api.x.ai/v1/stt", "Grok retry uses the direct xAI batch endpoint");
            Check(request.Headers.Authorization?.Parameter == "xai-test-only", "Grok retry uses the xAI bearer key");
            var body = await request.Content!.ReadAsStringAsync(token);
            Check(body.Contains("Hashirama") && body.Contains("audio.wav"), "Grok batch retry carries dictionary keyterms and audio");
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"text\":\"Hashirama\",\"duration\":1.0}") };
        }));
        var metrics = new SessionMetrics();
        Check(await new XaiBatchTranscriber(http).TranscribeAsync([1, 2, 3], "wav", "xai-test-only", ["Hashirama"], metrics, default) == "Hashirama", "Grok batch retry returns the transcript");
        Check(metrics.Snapshot().Costs is [{ Category: "voice", Model: XaiTranscription.Model, Amount: > 0 }], "Grok batch retry records its estimated xAI cost");
        using var chunkFinal = JsonDocument.Parse("{\"type\":\"transcript.partial\",\"text\":\"Hashirama \",\"is_final\":true,\"speech_final\":false}");
        using var interim = JsonDocument.Parse("{\"type\":\"transcript.partial\",\"text\":\"Hashira\",\"is_final\":false,\"speech_final\":false}");
        using var emptyPartial = JsonDocument.Parse("{\"type\":\"transcript.partial\",\"is_final\":true,\"speech_final\":true}");
        using var tail = JsonDocument.Parse("{\"type\":\"transcript.done\",\"text\":\" and Raikage\",\"duration\":7.9}");
        using var textlessDone = JsonDocument.Parse("{\"type\":\"transcript.done\",\"duration\":7.9}");
        Check(XaiStreamingSession.PartialFinalText(chunkFinal) == "Hashirama", "Locked streaming chunks are kept even with interim results off");
        Check(XaiStreamingSession.PartialFinalText(interim) is null, "Mutable interim text is not kept as transcript");
        Check(XaiStreamingSession.PartialFinalText(emptyPartial) is null, "Textless partial events contribute nothing");
        Check(XaiStreamingSession.DoneText(tail) == "and Raikage", "The flushed tail is kept alongside streamed chunks");
        Check(XaiStreamingSession.DoneText(textlessDone) is null, "A textless transcript.done falls back to streamed chunks instead of failing");
        var stamped = new SessionMetrics { TranscriptionModel = TranscriptionModels.GrokStreaming, CleanupMode = CleanupService.LunaFast };
        stamped.Complete("Pasted");
        var snap = stamped.Snapshot();
        Check(snap.TranscriptionModel == TranscriptionModels.GrokStreaming && snap.CleanupMode == CleanupService.LunaFast, "History metrics stamp the voice model and cleaner used");
        using var snapJson = JsonDocument.Parse(JsonSerializer.Serialize(snap, new JsonSerializerOptions(JsonSerializerDefaults.Web)));
        Check(snapJson.RootElement.GetProperty("transcriptionModel").GetString() == TranscriptionModels.GrokStreaming
            && snapJson.RootElement.GetProperty("cleanupMode").GetString() == CleanupService.LunaFast, "Stamped model and cleaner survive metrics JSON for history storage");
    }
    private static void Desktop()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Exception? failure = null;
        using var form = new Form { Text = "Local Whisper verification", Width = 400, Height = 180 };
        var button = new Button { Dock = DockStyle.Top, Text = "No edit here" };
        var field = new TextBox { Dock = DockStyle.Fill, Multiline = true };
        form.Controls.Add(button); form.Controls.Add(field);
        form.Shown += async (_, _) =>
        {
            IDataObject? original = Clipboard.GetDataObject();
            try
            {
                form.TopMost = true;
                SetForegroundWindow(form.Handle); form.Activate(); field.Focus();
                await Task.Delay(200);
                var focused = Native.GetForegroundWindow();
                if (focused == form.Handle)
                {
                    field.Text = "The animal was a cat, just as an example.";
                    field.Select(field.Text.IndexOf("cat", StringComparison.Ordinal), 3);
                    var context = await TargetContext.CaptureAsync(form.Handle, default);
                    Check(context.BeforeText.EndsWith("The animal was a ", StringComparison.Ordinal), "Target context captures text before the selection");
                    Check(context.SelectedText == "cat", "Target context captures selected text");
                    Check(context.AfterText.StartsWith(", just as an example.", StringComparison.Ordinal), "Target context captures text after the selection");
                    field.Clear();
                    Clipboard.SetText("clipboard sentinel");
                    Check(await Paste.IntoAsync("Hello, ä¸–ç•Œ!", form.Handle, default), "Native paste accepted");
                    await Task.Delay(50);
                    Check(field.Text == "Hello, ä¸–ç•Œ!", "Native paste inserts Unicode into focused field");
                    await Task.Delay(800);
                    Check(Clipboard.GetText() == "clipboard sentinel", "Previous clipboard restored");
                    Check(await TargetContext.AcceptsTextAsync(form.Handle, default) is true, "Focused text field accepts paste");
                    button.Focus();
                    await Task.Delay(200);
                    Check(await TargetContext.AcceptsTextAsync(form.Handle, default) is false, "Window without editable focus refuses paste");
                    var refused = field.Text;
                    Check(!await Paste.IntoAsync("nowhere to go", form.Handle, default, textTarget: TargetContext.AcceptsTextAsync), "Paste without editable focus is refused");
                    Check(field.Text == refused, "Refused paste does not change text");
                    field.Focus();
                    await Task.Delay(200);
                }
                else Console.WriteLine("SKIP: Windows denied test-window focus; live paste requires an interactive launch.");
                var before = field.Text;
                Check(!await Paste.IntoAsync("wrong target", (nint)12345, default), "Focus mismatch blocks paste");
                Check(field.Text == before, "Focus mismatch does not change text");
                using var recorder = new Recorder();
                recorder.Start();
                await Task.Delay(250);
                var wav = await recorder.StopAsync();
                Check(Encoding.ASCII.GetString(wav, 0, 4) == "RIFF" && wav.Length > 44, "Default microphone produces WAV data");
                using var hook = new GlobalShortcut();
                Check(true, "Global keyboard hook installs");
            }
            catch (Exception ex) { failure = ex; }
            finally
            {
                if (original is not null) Clipboard.SetDataObject(original, true);
                form.Close();
            }
        };
        Application.Run(form);
        if (failure is not null) throw failure;
    }
}

internal sealed class Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> handler) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return handler(request, cancellationToken);
    }
}
