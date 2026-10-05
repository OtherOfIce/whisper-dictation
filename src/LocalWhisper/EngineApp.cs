using System.Text.Json;
using System.Threading.Channels;

namespace LocalWhisper;

// Electron owns every visible window. This hidden Windows message pump serves the keyboard hook.
internal sealed class EngineApp : ApplicationContext
{
    private static readonly string ProbeFolder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LocalWhisper");
    private static readonly object ProbeLock = new();
    private static void Probe(string stage)
    {
        if (!File.Exists(Path.Combine(ProbeFolder, "learning-probe.enabled"))) return;
        try { lock (ProbeLock) File.AppendAllText(Path.Combine(ProbeFolder, "learning-probe.log"), $"{DateTime.UtcNow:O} {stage}{Environment.NewLine}"); }
        catch { }
    }
    private readonly Control dispatcher = new();
    private readonly Paste paste;
    private readonly GlobalShortcut? shortcut;
    private readonly System.Windows.Forms.Timer timer = new() { Interval = 35 };
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(45) };
    private readonly Gesture gesture;
    private readonly Channel<object> output = Channel.CreateUnbounded<object>();
    private readonly JsonSerializerOptions json = new(JsonSerializerDefaults.Web);
    private Recorder? recorder;
    private ITranscriptionSession? session;
    private Task<InsertionContext>? insertionContext;
    private SessionMetrics? metrics;
    private IDisposable? recordingStage;
    private CancellationTokenSource? operation;
    private readonly Dictionary<string, (byte[] Audio, string TranscriptionModel, string[] Dictionary)> failedAudio = new();
    private readonly LinkedList<string> failedOrder = new();
    private string apiKey = "", xaiApiKey = "", gatewayApiKey = "", cleanupMode = CleanupService.Off, transcriptionModel = TranscriptionModels.MaiClean, entryId = "";
    private string? processingPhase;
    private string microphoneDeviceId = "";
    private ShortcutBinding shortcutBinding = ShortcutBinding.Default;
    private Recorder? microphoneTest;
    private bool microphoneTestStopping, microphoneTestPlayback;
    private long microphoneTestStarted;
    private string[] dictionaryTerms = [];
    private readonly Dictionary<string, string> learnedEntries = new();
    private CancellationTokenSource? correctionObservation;
    private nint target;
    private bool liveChunks, doubleTranscription, lockMode = true, autoLearn = true, cancelled, exiting;
    private long lastTick = Environment.TickCount64, lastPublish;

    public EngineApp(bool noHook = false)
    {
        _ = dispatcher.Handle;
        paste = new Paste(dispatcher);
        _ = Task.Run(async () =>
        {
            await foreach (var message in output.Reader.ReadAllAsync())
            {
                await Console.Out.WriteLineAsync(JsonSerializer.Serialize(message, json));
                await Console.Out.FlushAsync();
            }
        });
        try { Settings.RemoveLegacyBalanceKey(); }
        catch { Notify("The old saved management key could not be removed. Delete balance-key.bin from LocalWhisper's local app data folder."); }
        try { apiKey = Settings.LoadKey(); xaiApiKey = Settings.LoadXaiKey(); gatewayApiKey = Settings.LoadGatewayKey(); liveChunks = Settings.LiveChunks; doubleTranscription = Settings.DoubleTranscription; lockMode = Settings.LockMode; autoLearn = Settings.AutoLearn; cleanupMode = Settings.CleanupMode; transcriptionModel = Settings.TranscriptionModel; dictionaryTerms = Settings.LoadDictionaryTerms(); }
        catch { Notify("Saved settings could not be read. Please open Settings."); }
        try { microphoneDeviceId = Settings.MicrophoneDeviceId; }
        catch { Notify("The saved microphone could not be read. Using the system default."); }
        gesture = new Gesture(lockMode);
        try { shortcutBinding = Settings.Shortcut; }
        catch { Notify("The saved shortcut could not be read. Using Ctrl + Win."); }
        if (!noHook)
        {
            shortcut = new GlobalShortcut();
            shortcut.Configure(shortcutBinding);
            shortcut.Captured += binding => Emit(new { type = "shortcutCaptured", shortcut = binding });
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
            if (microphoneTest is { } test && !microphoneTestStopping)
            {
                Emit(new { type = "microphoneTestLevel", level = test.Level, seconds = test.Seconds });
                if (now - microphoneTestStarted >= 5000 || test.HasStopped) _ = StopMicrophoneTestAsync(true);
            }
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
    private object SettingsState() => new { hasKey = !string.IsNullOrWhiteSpace(apiKey), hasXaiKey = !string.IsNullOrWhiteSpace(xaiApiKey), hasGatewayKey = !string.IsNullOrWhiteSpace(gatewayApiKey), models = TranscriptionModels.All, liveChunks, doubleTranscription, lockMode, autoLearn, cleanupMode, transcriptionModel, dictionaryTerms, shortcut = shortcutBinding, microphoneDeviceId, microphones = MicrophoneDevices.Available() };
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
                case "microphones": result = MicrophoneDevices.Available(); break;
                case "captureShortcut":
                    var capturing = command.GetProperty("params").GetProperty("enabled").GetBoolean();
                    if (capturing && gesture.Mode != CaptureMode.Idle) throw new InvalidOperationException("Finish recording before changing the shortcut.");
                    shortcut?.Capture(capturing); break;
                case "startMicrophoneTest":
                    if (gesture.Mode != CaptureMode.Idle || microphoneTest is not null) throw new InvalidOperationException("Finish the current recording or microphone test first.");
                    var testDevice = command.GetProperty("params").GetProperty("microphoneDeviceId").GetString() ?? "";
                    microphoneTest = new Recorder(RecorderMode.AtStop, MicrophoneDevices.Resolve(testDevice));
                    try { microphoneTest.Start(); microphoneTestStarted = Environment.TickCount64; }
                    catch (Exception ex) { microphoneTest.Dispose(); microphoneTest = null; throw new InvalidOperationException($"Could not open the microphone: {ex.Message}"); }
                    break;
                case "stopMicrophoneTest":
                    await StopMicrophoneTestAsync(command.GetProperty("params").GetProperty("playback").GetBoolean()); break;
                case "state": PublishState(); break;
                case "credits": result = await new Credits(http).GetAsync(apiKey); break;
                case "importActivity":
                    var managementKey = command.GetProperty("params").GetProperty("managementKey").GetString() ?? "";
                    result = await new Credits(http).ImportActivityAsync(apiKey, managementKey); break;
                case "setLockMode":
                    if (gesture.Mode != CaptureMode.Idle) throw new InvalidOperationException("Finish recording before changing settings.");
                    var requestedLockMode = command.GetProperty("params").GetProperty("lockMode").GetBoolean();
                    lockMode = requestedLockMode; Settings.SaveLockMode(lockMode); gesture.LockByDefault = lockMode;
                    result = SettingsState(); break;
                case "saveSettings":
                    if (gesture.Mode != CaptureMode.Idle) throw new InvalidOperationException("Finish recording before changing settings.");
                    var values = command.GetProperty("params");
                    if (microphoneTest is not null) throw new InvalidOperationException("Stop the microphone test before saving settings.");
                    var nextShortcut = values.TryGetProperty("shortcut", out var shortcutValue)
                        ? shortcutValue.Deserialize<ShortcutBinding>(json) ?? throw new InvalidOperationException("Invalid shortcut.") : shortcutBinding;
                    if (nextShortcut != shortcutBinding) nextShortcut.CheckAvailable();
                    var nextMicrophone = microphoneDeviceId;
                    if (values.TryGetProperty("microphoneDeviceId", out var microphone))
                    {
                        if (microphone.ValueKind != JsonValueKind.String || microphone.GetString()!.Length > 2048)
                            throw new InvalidOperationException("Invalid microphone selection.");
                        nextMicrophone = microphone.GetString()!;
                        if (nextMicrophone != microphoneDeviceId) MicrophoneDevices.Resolve(nextMicrophone);
                    }
                    var nextDictionary = dictionaryTerms;
                    if (values.TryGetProperty("dictionaryTerms", out var terms))
                    {
                        if (terms.ValueKind != JsonValueKind.Array) throw new InvalidOperationException("Invalid dictionary.");
                        nextDictionary = Vocabulary.Normalize(terms.EnumerateArray().Select(term => term.GetString()));
                    }
                    var nextModel = values.TryGetProperty("transcriptionModel", out var selectedModel)
                        ? selectedModel.GetString() ?? "" : transcriptionModel;
                    TranscriptionModels.ValidateDictionary(nextModel, nextDictionary);
                    if (values.TryGetProperty("apiKey", out var key) && !string.IsNullOrWhiteSpace(key.GetString())) { Settings.SaveKey(key.GetString()!.Trim()); apiKey = Settings.LoadKey(); }
                    if (values.TryGetProperty("xaiApiKey", out var xaiKey) && !string.IsNullOrWhiteSpace(xaiKey.GetString())) { Settings.SaveXaiKey(xaiKey.GetString()!.Trim()); xaiApiKey = Settings.LoadXaiKey(); }
                    if (values.TryGetProperty("gatewayApiKey", out var gatewayKey) && !string.IsNullOrWhiteSpace(gatewayKey.GetString())) { Settings.SaveGatewayKey(gatewayKey.GetString()!.Trim()); gatewayApiKey = Settings.LoadGatewayKey(); }
                    if (values.TryGetProperty("liveChunks", out var live)) { liveChunks = live.GetBoolean(); Settings.SaveLiveChunks(liveChunks); }
                    if (values.TryGetProperty("doubleTranscription", out var doubled)) { doubleTranscription = doubled.GetBoolean(); Settings.SaveDoubleTranscription(doubleTranscription); }
                    if (values.TryGetProperty("lockMode", out var lockSetting)) { lockMode = lockSetting.GetBoolean(); Settings.SaveLockMode(lockMode); gesture.LockByDefault = lockMode; }
                    if (values.TryGetProperty("autoLearn", out var learning)) { autoLearn = learning.GetBoolean(); Settings.SaveAutoLearn(autoLearn); if (!autoLearn) correctionObservation?.Cancel(); }
                    if (values.TryGetProperty("cleanupMode", out var cleanup)) { Settings.SaveCleanupMode(cleanup.GetString() ?? ""); cleanupMode = Settings.CleanupMode; }
                    if (values.TryGetProperty("transcriptionModel", out var model)) { Settings.SaveTranscriptionModel(model.GetString() ?? ""); transcriptionModel = Settings.TranscriptionModel; }
                    if (values.TryGetProperty("microphoneDeviceId", out _)) { Settings.SaveMicrophoneDeviceId(nextMicrophone); microphoneDeviceId = nextMicrophone; }
                    Settings.SaveDictionaryTerms(nextDictionary); dictionaryTerms = nextDictionary; learnedEntries.Clear();
                    if (nextShortcut != shortcutBinding)
                    {
                        Settings.SaveShortcut(nextShortcut); shortcutBinding = nextShortcut;
                        shortcut?.Configure(shortcutBinding); gesture.Reset();
                    }
                    result = SettingsState(); break;
                case "saveDictionary":
                    if (gesture.Mode != CaptureMode.Idle) throw new InvalidOperationException("Finish recording before changing settings.");
                    var dictionaryParams = command.GetProperty("params");
                    if (dictionaryParams.TryGetProperty("expectedDictionaryTerms", out var expectedTerms) &&
                        !dictionaryTerms.SequenceEqual(expectedTerms.EnumerateArray().Select(term => term.GetString())))
                        throw new InvalidOperationException("Dictionary changed during sync. Sync will retry.");
                    var importedTerms = dictionaryParams.GetProperty("dictionaryTerms");
                    if (importedTerms.ValueKind != JsonValueKind.Array) throw new InvalidOperationException("Invalid dictionary.");
                    var importedDictionary = Vocabulary.Normalize(importedTerms.EnumerateArray().Select(term => term.GetString()));
                    TranscriptionModels.ValidateDictionary(transcriptionModel, importedDictionary);
                    Settings.SaveDictionaryTerms(importedDictionary); dictionaryTerms = importedDictionary;
                    if (!dictionaryParams.TryGetProperty("preserveLearning", out var preserveLearning) || !preserveLearning.GetBoolean()) learnedEntries.Clear();
                    result = SettingsState(); break;
                case "undoLearning":
                    var learnedId = command.GetProperty("params").GetProperty("id").GetString() ?? "";
                    result = RemoveLearned(learnedId);
                    if ((bool)result) correctionObservation?.Cancel();
                    break;
                case "retranscribe":
                    result = await RetranscribeAsync(command.GetProperty("params").GetProperty("id").GetString() ?? "");
                    break;
                case "transcribeFile":
                    var fileParams = command.GetProperty("params");
                    result = await TranscribeFileAsync(fileParams.GetProperty("path").GetString() ?? "",
                        fileParams.GetProperty("format").GetString() ?? "wav",
                        fileParams.GetProperty("model").GetString() ?? "",
                        fileParams.TryGetProperty("fallback", out var fallbackValue) && fallbackValue.GetBoolean());
                    break;
                case "cancel": Cancel(); break;
                case "finish":
                    var finishParams = command.TryGetProperty("params", out var suppliedFinishParams) ? suppliedFinishParams : default;
                    Apply(gesture.Finish(), finishParams.ValueKind is not JsonValueKind.Undefined && finishParams.TryGetProperty("fromOverlay", out var fromOverlay) && fromOverlay.GetBoolean()); break;
                case "shutdown": ExitThread(); return;
                default: throw new InvalidOperationException("Unknown command.");
            }
            Emit(new { type = "reply", id, result });
        }
            catch (Exception ex) { Emit(new { type = "reply", id, error = ex is InvalidOperationException or HttpRequestException or AggregateException ? ex.Message : "The request failed. Check your key or connection and try again." }); }
    }
    private void Apply(GestureAction action, bool restoreTarget = false)
    {
        if (exiting) return;
        if (action == GestureAction.Start)
        {
            if (microphoneTest is not null) { gesture.Reset(); Notify("Stop the microphone test before dictating."); return; }
            correctionObservation?.Cancel(); correctionObservation = null;
            var effectiveCleanup = cleanupMode;
            if (!Pipeline().Available(transcriptionModel, dictionaryTerms)
                || (effectiveCleanup != CleanupService.Off && string.IsNullOrWhiteSpace(apiKey)))
            { gesture.Reset(); Emit(new { type = "needsSettings" }); return; }
            target = Native.GetForegroundWindow(); cancelled = false; processingPhase = null;
            metrics = new SessionMetrics(); entryId = Guid.NewGuid().ToString("N");
            metrics.TranscriptionModel = transcriptionModel; metrics.RequestedTranscriptionModel = transcriptionModel; metrics.CleanupMode = effectiveCleanup;
            operation = new CancellationTokenSource();
            insertionContext = effectiveCleanup == CleanupService.Off ? null : TargetContext.CaptureAsync(target, operation.Token);
            recordingStage = metrics.Measure("Recording"); lastTick = Environment.TickCount64;
            try
            {
                var created = Pipeline().CreateSession(transcriptionModel, liveChunks, doubleTranscription, dictionaryTerms, metrics, operation.Token);
                session = created.Session;
                var recorderMode = created.Mode;
                recorder = new Recorder(recorderMode, MicrophoneDevices.Resolve(microphoneDeviceId));
                if (session is not null) recorder.ChunkReady += session.EnqueuePcm;
                using (metrics.Measure("Open microphone")) recorder.Start();
            }
            catch (Exception ex)
            {
                recorder?.Dispose(); recorder = null; gesture.Reset();
                operation.Cancel(); operation.Dispose(); operation = null; session = null;
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
            if (audio is null || audio.Length < 6444) { cancellation.Cancel(); outcome = "Too short"; return; }
            {
                active.EnqueuePcm(pcm);
                Exception? primaryFailure = null;
                try { rawText = await active.FinishAsync(); }
                catch (Exception ex) when (ModelTranscription.CanFallback(ex, cancellation.Token)) { primaryFailure = ex; }
                if (string.IsNullOrWhiteSpace(rawText) && primaryFailure is null)
                    primaryFailure = new InvalidDataException("The selected model returned no transcript.");
                if (active.Failed > 0 || primaryFailure is not null)
                {
                    var partialText = rawText;
                    trace.Fallback(transcriptionModel, primaryFailure?.Message ?? active.LastError ?? "Part of the recording could not be transcribed.");
                    try
                    {
                        var fallback = await CreateModelTranscription(trace, dictionaryTerms).TranscribeWithFallbackAsync(
                            audio, "wav", transcriptionModel, dictionaryTerms, trace, cancellation.Token,
                            // Keep engine state updates on the UI thread.
                            skipRequested: transcriptionModel != TranscriptionModels.GrokStreaming);
                        rawText = fallback.Text;
                        if (fallback.UsedModel != transcriptionModel)
                            Notify($"{ModelLabel(transcriptionModel)} failed. {ModelLabel(fallback.UsedModel)} produced the transcript instead.");
                    }
                    catch when (!string.IsNullOrWhiteSpace(partialText))
                    {
                        rawText = partialText;
                        KeepFailedAudio(id, audio, transcriptionModel, dictionaryTerms);
                        Notify("Every fallback model failed. The partial transcript and full recording were kept in History.");
                    }
                }
            }
            text = rawText;
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
                CorrectionLearning.Snapshot? snapshot = null;
                if (autoLearn)
                    try { snapshot = await CorrectionLearning.CaptureAsync(target, cancellation.Token, Probe); }
                    catch (TimeoutException) { Probe("capture-timeout"); }
                else Probe("learning-disabled");
                if (await paste.IntoAsync(text, target, cancellation.Token, () => { trace.Pasted(); PublishState(); }, trace, TargetContext.AcceptsTextAsync))
                {
                    outcome = "Pasted";
                    Probe(snapshot is null ? "pasted-without-capture" : "pasted-with-capture");
                    if (snapshot is not null && autoLearn)
                    {
                        correctionObservation = new CancellationTokenSource();
                        var observation = correctionObservation;
                        var learnedByIndex = new Dictionary<int, string>();
                        CorrectionLearning.Observe(snapshot, text, observation.Token,
                            update => { if (!exiting && !observation.IsCancellationRequested) dispatcher.BeginInvoke(() =>
                            {
                                if (!observation.IsCancellationRequested) ApplyCorrectionUpdate(update, learnedByIndex);
                            }); }, Probe);
                    }
                }
                else { outcome = "Saved to history"; Probe("paste-skipped"); } // Electron copies this transcript to the clipboard and shows the Copy action.
            }
        }
        catch (OperationCanceledException) { text = ""; outcome = cancellation.IsCancellationRequested ? "Cancelled" : "Timed out"; if (outcome == "Timed out") Notify("Transcription timed out. See the timing details in History."); }
        catch (Exception ex)
        {
            if (audio is not null) KeepFailedAudio(id, audio, transcriptionModel, dictionaryTerms);
            Notify(ex.Message + (audio is not null ? " Your recording was kept in History – you can play it back or retry transcription." : ""));
        }
        finally
        {
            trace.Complete(outcome); cancellation.Cancel(); cancellation.Dispose(); operation = null; metrics = null; session = null; insertionContext = null; processingPhase = null; gesture.Reset();
            if (!exiting)
            {
                PublishState();
                if (outcome != "Cancelled") Emit(new { type = "transcript", entry = new { id, text, rawText, metrics = trace.Snapshot(), audio = audio is null ? null : Convert.ToBase64String(audio), audioFormat = audio is null ? null : "wav" } });
                _ = UpdateCompletedMetricsAsync(id, trace);
            }
        }
    }
    private void ApplyCorrectionUpdate(CorrectionLearning.CorrectionUpdate update, Dictionary<int, string> learnedByIndex)
    {
        if (exiting || !autoLearn) return;
        if (learnedByIndex.Remove(update.Index, out var priorId)) RemoveLearned(priorId);
        if (update.Term is { } term && Learn(term) is { } id) learnedByIndex[update.Index] = id;
    }
    private bool RemoveLearned(string id)
    {
        if (!learnedEntries.TryGetValue(id, out var term)) return false;
        if (!dictionaryTerms.Contains(term, StringComparer.Ordinal)) { learnedEntries.Remove(id); return false; }
        var next = dictionaryTerms.Where(item => !string.Equals(item, term, StringComparison.Ordinal)).ToArray();
        Settings.SaveDictionaryTerms(next); dictionaryTerms = next; learnedEntries.Remove(id);
        Emit(new { type = "dictionaryLearningUndone", term, settings = SettingsState() });
        return true;
    }
    private string? Learn(string term)
    {
        if (exiting || !autoLearn || dictionaryTerms.Contains(term, StringComparer.OrdinalIgnoreCase)) { Probe("learn-skipped"); return null; }
        try
        {
            var next = Vocabulary.Normalize([.. dictionaryTerms, term]);
            TranscriptionModels.ValidateDictionary(transcriptionModel, next);
            Settings.SaveDictionaryTerms(next);
            dictionaryTerms = next;
            var id = Guid.NewGuid().ToString("N");
            learnedEntries[id] = term;
            Probe("learn-saved");
            Emit(new { type = "dictionaryLearned", id, term, settings = SettingsState() });
            return id;
        }
        catch (Exception) { Probe("learn-error"); Notify("Could not save the learned word. Check your dictionary in Settings."); return null; }
    }
    private TranscriptionPipeline Pipeline() => new(http, new(apiKey, xaiApiKey, gatewayApiKey));
    private ModelTranscription CreateModelTranscription(SessionMetrics trace, IReadOnlyList<string> dictionary) => Pipeline().Recorded(trace, dictionary);
    private static string ModelLabel(string model) => TranscriptionModels.Describe(model).Label;
    private async Task<object> TranscribeFileAsync(string path, string format, string model, bool useFallback)
    {
        if (!TranscriptionModels.IsValid(model)) throw new InvalidOperationException("Choose a valid transcription model.");
        var fullPath = Path.GetFullPath(path);
        var info = new FileInfo(fullPath);
        if (!info.Exists || info.Length is <= 44 or > 50 * 1024 * 1024) throw new InvalidOperationException("The saved recording is unavailable or invalid.");
        var source = await File.ReadAllBytesAsync(fullPath).ConfigureAwait(false);
        var comparisonMetrics = new SessionMetrics { CleanupMode = CleanupService.Off };
        comparisonMetrics.Audio(Transcriber.EstimateAudioSeconds(source, format), source.Length);
        var modelTranscription = CreateModelTranscription(comparisonMetrics, dictionaryTerms);
        var result = useFallback
            ? await modelTranscription.TranscribeWithFallbackAsync(source, format, model, dictionaryTerms, comparisonMetrics, CancellationToken.None).ConfigureAwait(false)
            : await modelTranscription.TranscribeExactAsync(source, format, model, dictionaryTerms, comparisonMetrics, CancellationToken.None).ConfigureAwait(false);
        comparisonMetrics.Complete(useFallback ? "Retried" : "Alternate transcript");
        return new { text = result.Text, rawText = result.Text, metrics = comparisonMetrics.Snapshot() };
    }
    private void KeepFailedAudio(string id, byte[] audio, string model, string[] dictionary)
    {
        lock (failedAudio)
        {
            failedAudio[id] = (audio, model, dictionary);
            failedOrder.Remove(id); failedOrder.AddLast(id);
            while (failedOrder.Count > 5 && failedOrder.First is { } oldest)
            {
                failedOrder.RemoveFirst();
                failedAudio.Remove(oldest.Value);
            }
        }
    }
    private async Task<object> RetranscribeAsync(string id)
    {
        (byte[] Audio, string TranscriptionModel, string[] Dictionary) saved;
        lock (failedAudio)
        {
            if (!failedAudio.TryGetValue(id, out saved))
                throw new InvalidOperationException("No saved recording is available for retry. Play back the audio or dictate again.");
        }
        var retryMetrics = new SessionMetrics();
        // Retries skip AI cleanup and paste the raw transcript, so the recorded
        // cleaner is off even when the original attempt used Luna.
        retryMetrics.TranscriptionModel = saved.TranscriptionModel;
        retryMetrics.RequestedTranscriptionModel = saved.TranscriptionModel;
        retryMetrics.CleanupMode = CleanupService.Off;
        var retried = await CreateModelTranscription(retryMetrics, saved.Dictionary).TranscribeExactAsync(
            saved.Audio, "wav", saved.TranscriptionModel, saved.Dictionary, retryMetrics, CancellationToken.None).ConfigureAwait(false);
        var text = retried.Text;
        if (string.IsNullOrWhiteSpace(text)) throw new InvalidOperationException("The retry returned no speech. Try again.");
        retryMetrics.Complete("Retried");
        lock (failedAudio) { failedAudio.Remove(id); failedOrder.Remove(id); }
        return new { id, text, rawText = text, metrics = retryMetrics.Snapshot() };
    }
    private async Task UpdateCompletedMetricsAsync(string id, SessionMetrics trace)
    {
        await Task.WhenAll(Task.Delay(850), trace.WaitForBackgroundAsync());
        if (!exiting) Emit(new { type = "metricsUpdated", id, metrics = trace.Snapshot() });
    }
    private async Task StopMicrophoneTestAsync(bool playback)
    {
        if (!playback) microphoneTestPlayback = false;
        if (microphoneTest is not { } capture || microphoneTestStopping) return;
        microphoneTestStopping = true; microphoneTestPlayback = playback;
        try
        {
            var audio = await capture.StopAsync();
            if (!exiting) Emit(new { type = "microphoneTestStopped", audio = microphoneTestPlayback ? Convert.ToBase64String(audio) : null });
        }
        catch (Exception ex)
        {
            if (!exiting) Emit(new { type = "microphoneTestStopped", error = $"Could not finish the microphone test: {ex.Message}" });
        }
        finally { capture.Dispose(); microphoneTest = null; microphoneTestStopping = false; }
    }
    private void Cancel()
    {
        if (microphoneTest is not null) { _ = StopMicrophoneTestAsync(false); return; }
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
        exiting = true; correctionObservation?.Cancel(); timer.Stop(); timer.Dispose(); shortcut?.Dispose(); operation?.Cancel(); recorder?.Dispose(); microphoneTest?.Dispose();
        dispatcher.Dispose(); http.Dispose(); output.Writer.TryComplete(); base.ExitThreadCore();
    }
}
