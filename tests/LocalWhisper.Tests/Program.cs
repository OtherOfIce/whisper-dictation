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
            if (args.Contains("--credits"))
            {
                using var http = new HttpClient();
                var balance = new Credits(http).GetAsync(Settings.LoadKey(), Settings.LoadBalanceKey()).GetAwaiter().GetResult();
                Console.WriteLine($"kind={balance.Kind} usageAvailable={balance.Usage.HasValue} remainingAvailable={balance.Remaining.HasValue}");
                return;
            }
            Gestures();
            Api().GetAwaiter().GetResult();
            CleanupChecks.RunAsync(Check).GetAwaiter().GetResult();
            VocabularyChecks.RunAsync(Check).GetAwaiter().GetResult();
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
            var result = await new Credits(http).GetAsync("test-only", "");
            Check(result.Kind == kind, "Account balance and key allowance stay distinct");
            Check(result.Usage == 1.5m && result.UsageDaily == .2m, "Existing key usage is retained when balance is forbidden");
            Check(result.Remaining == (kind == "account" ? 75m : kind == "key" ? 8.5m : (decimal?)null), "An unlimited key is not treated as an account balance");
        }
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
        Check(g.Press(1450) == GestureAction.None && g.Mode == CaptureMode.Locked, "Second tap locks same recording");
        Check(g.Release(1500) == GestureAction.None && g.Mode == CaptureMode.Locked, "Release keeps locked capture alive");
        Check(g.Tick(60000) == GestureAction.None, "Locked capture does not finish on timer");
        Check(g.Press(61000) == GestureAction.Finish, "Next press finishes locked capture");
        g.Reset(); g.Press(0); g.Release(100);
        Check(g.Tick(451) == GestureAction.Finish, "Single tap eventually submits");
        g.Reset(); g.Press(0); g.Release(100);
        Check(g.Press(451) == GestureAction.Finish, "Late tap cannot lock");
        var lockedByDefault = new Gesture(true);
        Check(lockedByDefault.Press(0) == GestureAction.Start && lockedByDefault.Mode == CaptureMode.Locked, "Lock mode starts directly locked");
        Check(lockedByDefault.Release(100) == GestureAction.None && lockedByDefault.Mode == CaptureMode.Locked, "Lock mode ignores shortcut release");
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
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"text\":\"  Hello, ä¸–ç•Œ!  \"}", Encoding.UTF8, "application/json") };
        }));
        Check(await new Transcriber(http).TranscribeAsync([1, 2, 3], "test-only", default) == "Hello, ä¸–ç•Œ!", "Unicode transcript preserved");
        foreach (var status in new[] { 401, 402, 429, 500 })
        {
            using var failed = new HttpClient(new Handler((_, _) => Task.FromResult(new HttpResponseMessage((HttpStatusCode)status))));
            try { await new Transcriber(failed).TranscribeAsync([0], "test-only", default); throw new Exception("Expected API error"); }
            catch (HttpRequestException ex) { Check(!ex.Message.Contains("test-only"), "API errors do not expose key"); }
        }
        using var malformed = new HttpClient(new Handler((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{}") })));
        try { await new Transcriber(malformed).TranscribeAsync([0], "test-only", default); throw new Exception("Expected malformed response error"); }
        catch (InvalidDataException) { Check(true, "Missing text is rejected"); }
        using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
        try { await new Transcriber(http).TranscribeAsync([0], "test-only", cancelled.Token); throw new Exception("Expected cancellation"); }
        catch (OperationCanceledException) { Check(true, "Cancelled requests abort"); }
    }
    private static void Desktop()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Exception? failure = null;
        using var form = new Form { Text = "Local Whisper verification", Width = 400, Height = 180 };
        var field = new TextBox { Dock = DockStyle.Fill, Multiline = true };
        form.Controls.Add(field);
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
                    Clipboard.SetText("clipboard sentinel");
                    Check(await Paste.IntoAsync("Hello, ä¸–ç•Œ!", form.Handle, default), "Native paste accepted");
                    await Task.Delay(50);
                    Check(field.Text == "Hello, ä¸–ç•Œ!", "Native paste inserts Unicode into focused field");
                    await Task.Delay(800);
                    Check(Clipboard.GetText() == "clipboard sentinel", "Previous clipboard restored");
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
