using System.Text.Json;
using System.Threading.Channels;

namespace LocalWhisper;

// Electron owns every visible window. This hidden Windows message pump serves the keyboard hook.
internal sealed class EngineApp : ApplicationContext
{
    private readonly Control dispatcher = new();
    private readonly GlobalShortcut? shortcut;
    private readonly System.Windows.Forms.Timer timer = new() { Interval = 35 };
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(45) };
    private readonly Gesture gesture;
    private readonly Channel<object> output = Channel.CreateUnbounded<object>();
    private readonly JsonSerializerOptions json = new(JsonSerializerDefaults.Web);
    private Recorder? recorder;
    private TranscriptionSession? session;
    private Task<InsertionContext>? insertionContext;
    private SessionMetrics? metrics;
    private IDisposable? recordingStage;
    private CancellationTokenSource? operation;
    private string apiKey = "", balanceKey = "", cleanupMode = CleanupService.Off, transcriptionModel = TranscriptionModels.MaiClean, entryId = "";
    private string? processingPhase;
    private string[] dictionaryTerms = [];
    private nint target;
    private bool liveChunks, lockMode = true, cancelled, exiting;
    private long lastTick = Environment.TickCount64, lastPublish;

    public EngineApp(bool noHook = false)
    {
        _ = dispatcher.Handle;
        _ = Task.Run(async () =>
        {
            await foreach (var message in output.Reader.ReadAllAsync())
            {
                await Console.Out.WriteLineAsync(JsonSerializer.Serialize(message, json));
                await Console.Out.FlushAsync();
            }
        });
        try { apiKey = Settings.LoadKey(); balanceKey = Settings.LoadBalanceKey(); liveChunks = Settings.LiveChunks; lockMode = Settings.LockMode; cleanupMode = Settings.CleanupMode; transcriptionModel = Settings.TranscriptionModel; dictionaryTerms = Settings.LoadDictionaryTerms(); }
        catch { Notify("Saved settings could not be read. Please open Settings."); }
        gesture = new Gesture(lockMode);
        if (!noHook)
        {
            shortcut = new GlobalShortcut();
            shortcut.Changed += pressed =>
            {
                var now = Environment.TickCount64;
                if (!exiting) dispatcher.BeginInvoke(() => Apply(pressed ? gesture.Press(now) : gesture.Release(now)));
            };
            shortcut.EscapePressed += () => { if (!exiting) dispatcher.BeginInvoke(Cancel); };
        }
        timer.Tick += (_, _) =>
        {
            var now = Environment.TickCount64;
            metrics?.UiGap(now - lastTick); lastTick = now;
            Apply(gesture.Tick(now));
            if (recorder is { } r)
            {
                metrics?.Audio(r.Seconds, (long)(r.Seconds * 32000));
                if (r.Seconds >= 300 || r.HasStopped) Apply(gesture.Finish());
            }
            if (gesture.Mode != CaptureMode.Idle && now - lastPublish >= 100) { PublishState(); lastPublish = now; }
        };
        timer.Start();
        Emit(new { type = "ready", settings = SettingsState() });
        _ = Task.Run(async () =>
        {
            while (await Console.In.ReadLineAsync() is { } line)
            {
                if (line.Length > 131072) continue;
                try
                {
                    var command = JsonSerializer.Deserialize<JsonElement>(line);
                    if (!exiting) dispatcher.BeginInvoke(() => Handle(command));
                }
                catch (JsonException) { }
            }
            if (!exiting) dispatcher.BeginInvoke(ExitThread);
        });
    }
    private object SettingsState() => new { hasKey = !string.IsNullOrWhiteSpace(apiKey), hasBalanceKey = !string.IsNullOrWhiteSpace(balanceKey), liveChunks, lockMode, cleanupMode, transcriptionModel, dictionaryTerms };
    private void Emit(object value) => output.Writer.TryWrite(value);
    private void Notify(string message) => Emit(new { type = "notice", message });
    private void PublishState() => Emit(new { type = "state", mode = cancelled || metrics?.Snapshot().PasteMs is not null ? "Idle" : gesture.Mode.ToString(), phase = processingPhase, level = recorder?.Level ?? 0, id = entryId, metrics = metrics?.Snapshot() });
    private async void Handle(JsonElement command)
    {
        var id = command.TryGetProperty("id", out var requestId) ? requestId.GetInt32() : 0;
        try
        {
            var method = command.GetProperty("method").GetString();
            object? result = null;
            switch (method)
            {
                case "settings": result = SettingsState(); break;
                case "state": PublishState(); break;
                case "credits": result = await new Credits(http).GetAsync(apiKey, balanceKey); break;
                case "setLockMode":
                    if (gesture.Mode != CaptureMode.Idle) throw new InvalidOperationException("Finish recording before changing settings.");
                    var requestedLockMode = command.GetProperty("params").GetProperty("lockMode").GetBoolean();
                    lockMode = requestedLockMode; Settings.SaveLockMode(lockMode); gesture.LockByDefault = lockMode;
                    result = SettingsState(); break;
                case "saveSettings":
                    if (gesture.Mode != CaptureMode.Idle) throw new InvalidOperationException("Finish recording before changing settings.");
                    var values = command.GetProperty("params");
                    var nextDictionary = dictionaryTerms;
                    if (values.TryGetProperty("dictionaryTerms", out var terms))
                    {
                        if (terms.ValueKind != JsonValueKind.Array) throw new InvalidOperationException("Invalid dictionary.");
                        nextDictionary = Vocabulary.Normalize(terms.EnumerateArray().Select(term => term.GetString()));
                    }
                    if (values.TryGetProperty("apiKey", out var key) && !string.IsNullOrWhiteSpace(key.GetString())) { Settings.SaveKey(key.GetString()!.Trim()); apiKey = Settings.LoadKey(); }
                    if (values.TryGetProperty("balanceKey", out var balance) && !string.IsNullOrWhiteSpace(balance.GetString())) { Settings.SaveBalanceKey(balance.GetString()!.Trim()); balanceKey = Settings.LoadBalanceKey(); }
                    if (values.TryGetProperty("clearBalanceKey", out var clear) && clear.GetBoolean()) { Settings.SaveBalanceKey(""); balanceKey = ""; }
                    if (values.TryGetProperty("liveChunks", out var live)) { liveChunks = live.GetBoolean(); Settings.SaveLiveChunks(liveChunks); }
                    if (values.TryGetProperty("lockMode", out var lockSetting)) { lockMode = lockSetting.GetBoolean(); Settings.SaveLockMode(lockMode); gesture.LockByDefault = lockMode; }
                    if (values.TryGetProperty("cleanupMode", out var cleanup)) { Settings.SaveCleanupMode(cleanup.GetString() ?? ""); cleanupMode = Settings.CleanupMode; }
                    if (values.TryGetProperty("transcriptionModel", out var model)) { Settings.SaveTranscriptionModel(model.GetString() ?? ""); transcriptionModel = Settings.TranscriptionModel; }
                    Settings.SaveDictionaryTerms(nextDictionary); dictionaryTerms = nextDictionary;
                    result = SettingsState(); break;
                case "saveDictionary":
                    if (gesture.Mode != CaptureMode.Idle) throw new InvalidOperationException("Finish recording before changing settings.");
                    var importedTerms = command.GetProperty("params").GetProperty("dictionaryTerms");
                    if (importedTerms.ValueKind != JsonValueKind.Array) throw new InvalidOperationException("Invalid dictionary.");
                    var importedDictionary = Vocabulary.Normalize(importedTerms.EnumerateArray().Select(term => term.GetString()));
                    Settings.SaveDictionaryTerms(importedDictionary); dictionaryTerms = importedDictionary;
                    result = SettingsState(); break;
                case "cancel": Cancel(); break;
                case "finish":
                    var finishParams = command.TryGetProperty("params", out var suppliedFinishParams) ? suppliedFinishParams : default;
                    Apply(gesture.Finish(), finishParams.ValueKind is not JsonValueKind.Undefined && finishParams.TryGetProperty("fromOverlay", out var fromOverlay) && fromOverlay.GetBoolean()); break;
                case "shutdown": ExitThread(); return;
                default: throw new InvalidOperationException("Unknown command.");
            }
            Emit(new { type = "reply", id, result });
        }
        catch (Exception ex) { Emit(new { type = "reply", id, error = ex is InvalidOperationException ? ex.Message : "The request failed. Check your key or connection and try again." }); }
    }
    private void Apply(GestureAction action, bool restoreTarget = false)
    {
        if (exiting) return;
        if (action == GestureAction.Start)
        {
            if (string.IsNullOrWhiteSpace(apiKey)) { gesture.Reset(); Emit(new { type = "needsSettings" }); return; }
            target = Native.GetForegroundWindow(); cancelled = false; processingPhase = null;
            metrics = new SessionMetrics(); entryId = Guid.NewGuid().ToString("N");
            operation = new CancellationTokenSource();
            insertionContext = cleanupMode == CleanupService.Off ? null : TargetContext.CaptureAsync(target, operation.Token);
            session = new TranscriptionSession(http, apiKey, metrics, operation.Token, dictionaryTerms, transcriptionModel);
            recordingStage = metrics.Measure("Recording"); lastTick = Environment.TickCount64;
            try
            {
                recorder = new Recorder(liveChunks);
                var active = session; recorder.ChunkReady += active.EnqueuePcm;
                using (metrics.Measure("Open microphone")) recorder.Start();
            }
            catch (Exception ex)
            {
                recorder?.Dispose(); recorder = null; gesture.Reset();
                operation.Dispose(); operation = null;
                insertionContext = null;
                recordingStage.Dispose(); recordingStage = null;
                metrics.Complete("Microphone error"); metrics = null;
                Notify($"Could not open the microphone: {ex.Message}");
            }
            PublishState();
        }
        else if (action == GestureAction.Finish) _ = FinishAsync(restoreTarget);
    }
    private async Task FinishAsync(bool restoreTarget)
    {
        var capture = recorder; recorder = null;
        var active = session; var trace = metrics; var cancellation = operation; var id = entryId;
        var capturedContext = insertionContext; insertionContext = null;
        if (capture is null || active is null || trace is null || cancellation is null) { gesture.Reset(); PublishState(); return; }
        recordingStage?.Dispose(); recordingStage = null; trace.Stopped(); processingPhase = "transcribing"; PublishState();
        var outcome = "Failed"; var rawText = ""; var text = ""; byte[]? audio = null;
        try
        {
            byte[] pcm;
            using (trace.Measure("Stop microphone")) pcm = await Task.Run(async () =>
            {
                using (capture)
                {
                    var tail = await capture.StopPcmAsync().ConfigureAwait(false);
                    audio = capture.RecordedWav();
                    trace.Audio(capture.Seconds, (long)(capture.Seconds * 32000)); return tail;
                }
            });
            cancellation.Token.ThrowIfCancellationRequested();
            if (pcm.Length < 6400 && active.Count == 0) { outcome = "Too short"; return; }
            active.EnqueuePcm(pcm); rawText = await active.FinishAsync(); text = rawText;
            cancellation.Token.ThrowIfCancellationRequested();
            if (text.Length == 0) { outcome = "No speech"; return; }
            if (cleanupMode != CleanupService.Off)
            {
                processingPhase = "luna"; PublishState();
                try
                {
                    var context = capturedContext is null ? InsertionContext.Empty : await capturedContext;
                    using (trace.Measure(cleanupMode == CleanupService.LunaFast ? "AI cleanup (Luna Fast)" : "AI cleanup (Luna)"))
                    {
                        var tier = cleanupMode == CleanupService.LunaFast ? CleanupServiceTier.Fast : CleanupServiceTier.Standard;
                        var result = await new CleanupService(http).CleanupAsync(rawText, context, apiKey, tier, cancellation.Token);
                        text = result.Text; trace.Cost("cleanup", result.Model, result.Cost);
                    }
                }
                catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { throw; }
                catch (TimeoutException) { text = rawText; Notify("AI cleanup timed out. The original transcript was used."); }
                catch (Exception) { text = rawText; Notify("AI cleanup failed. The original transcript was used."); }
                cancellation.Token.ThrowIfCancellationRequested();
            }
            using (trace.Measure("Paste / wait for released keys"))
            {
                if (restoreTarget) Native.SetForegroundWindow(target);
                if (await Paste.IntoAsync(text, target, cancellation.Token, () => { trace.Pasted(); PublishState(); }, trace)) outcome = "Pasted";
                else { outcome = "Saved to history"; Notify("Focus changed. Your transcript is ready in History."); }
            }
        }
        catch (OperationCanceledException) { text = ""; outcome = cancellation.IsCancellationRequested ? "Cancelled" : "Timed out"; if (outcome == "Timed out") Notify("Transcription timed out. See the timing details in History."); }
        catch (Exception ex) { Notify(ex.Message); }
        finally
        {
            trace.Complete(outcome); cancellation.Dispose(); operation = null; metrics = null; session = null; insertionContext = null; processingPhase = null; gesture.Reset();
            if (!exiting)
            {
                PublishState();
                if (outcome != "Cancelled") Emit(new { type = "transcript", entry = new { id, text, rawText, metrics = trace.Snapshot(), audio = audio is null ? null : Convert.ToBase64String(audio), audioFormat = audio is null ? null : "wav" } });
                _ = UpdateCompletedMetricsAsync(id, trace);
            }
        }
    }
    private async Task UpdateCompletedMetricsAsync(string id, SessionMetrics trace)
    {
        await Task.Delay(850);
        if (!exiting) Emit(new { type = "metricsUpdated", id, metrics = trace.Snapshot() });
    }
    private void Cancel()
    {
        cancelled = true; operation?.Cancel(); PublishState();
        if (gesture.Mode == CaptureMode.Busy) return;
        var capture = recorder; recorder = null;
        recordingStage?.Dispose(); recordingStage = null; metrics?.Complete("Cancelled"); metrics = null;
        operation?.Dispose(); operation = null; session = null; insertionContext = null; gesture.Reset();
        if (capture is not null) _ = Task.Run(capture.Dispose);
    }
    protected override void ExitThreadCore()
    {
        if (exiting) return;
        exiting = true; timer.Stop(); timer.Dispose(); shortcut?.Dispose(); operation?.Cancel(); recorder?.Dispose();
        dispatcher.Dispose(); http.Dispose(); output.Writer.TryComplete(); base.ExitThreadCore();
    }
}
