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
    private string apiKey = "", xaiApiKey = "", cleanupMode = CleanupService.Off, transcriptionModel = TranscriptionModels.MaiClean, entryId = "";
    private string? processingPhase;
    private string[] dictionaryTerms = [];
    private readonly Dictionary<string, string> learnedEntries = new();
    private CancellationTokenSource? correctionObservation;
    private nint target;
    private bool liveChunks, doubleTranscription, lockMode = true, autoLearn = true, cancelled, exiting;
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
        try { Settings.RemoveLegacyBalanceKey(); }
        catch { Notify("The old saved management key could not be removed. Delete balance-key.bin from LocalWhisper's local app data folder."); }
        try { apiKey = Settings.LoadKey(); xaiApiKey = Settings.LoadXaiKey(); liveChunks = Settings.LiveChunks; doubleTranscription = Settings.DoubleTranscription; lockMode = Settings.LockMode; autoLearn = Settings.AutoLearn; cleanupMode = Settings.CleanupMode; transcriptionModel = Settings.TranscriptionModel; dictionaryTerms = Settings.LoadDictionaryTerms(); }
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
    private object SettingsState() => new { hasKey = !string.IsNullOrWhiteSpace(apiKey), hasXaiKey = !string.IsNullOrWhiteSpace(xaiApiKey), liveChunks, doubleTranscription, lockMode, autoLearn, cleanupMode, transcriptionModel, dictionaryTerms };
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
                    var nextDictionary = dictionaryTerms;
                    if (values.TryGetProperty("dictionaryTerms", out var terms))
                    {
                        if (terms.ValueKind != JsonValueKind.Array) throw new InvalidOperationException("Invalid dictionary.");
                        nextDictionary = Vocabulary.Normalize(terms.EnumerateArray().Select(term => term.GetString()));
                    }
                    var nextModel = values.TryGetProperty("transcriptionModel", out var selectedModel)
                        ? selectedModel.GetString() ?? "" : transcriptionModel;
                    if (TranscriptionModels.IsStreaming(nextModel)) XaiTranscription.ValidateKeyterms(nextDictionary);
                    if (values.TryGetProperty("apiKey", out var key) && !string.IsNullOrWhiteSpace(key.GetString())) { Settings.SaveKey(key.GetString()!.Trim()); apiKey = Settings.LoadKey(); }
                    if (values.TryGetProperty("xaiApiKey", out var xaiKey) && !string.IsNullOrWhiteSpace(xaiKey.GetString())) { Settings.SaveXaiKey(xaiKey.GetString()!.Trim()); xaiApiKey = Settings.LoadXaiKey(); }
                    if (values.TryGetProperty("liveChunks", out var live)) { liveChunks = live.GetBoolean(); Settings.SaveLiveChunks(liveChunks); }
                    if (values.TryGetProperty("doubleTranscription", out var doubled)) { doubleTranscription = doubled.GetBoolean(); Settings.SaveDoubleTranscription(doubleTranscription); }
                    if (values.TryGetProperty("lockMode", out var lockSetting)) { lockMode = lockSetting.GetBoolean(); Settings.SaveLockMode(lockMode); gesture.LockByDefault = lockMode; }
                    if (values.TryGetProperty("autoLearn", out var learning)) { autoLearn = learning.GetBoolean(); Settings.SaveAutoLearn(autoLearn); if (!autoLearn) correctionObservation?.Cancel(); }
                    if (values.TryGetProperty("cleanupMode", out var cleanup)) { Settings.SaveCleanupMode(cleanup.GetString() ?? ""); cleanupMode = Settings.CleanupMode; }
                    if (values.TryGetProperty("transcriptionModel", out var model)) { Settings.SaveTranscriptionModel(model.GetString() ?? ""); transcriptionModel = Settings.TranscriptionModel; }
                    Settings.SaveDictionaryTerms(nextDictionary); dictionaryTerms = nextDictionary; learnedEntries.Clear();
                    result = SettingsState(); break;
                case "saveDictionary":
                    if (gesture.Mode != CaptureMode.Idle) throw new InvalidOperationException("Finish recording before changing settings.");
                    var importedTerms = command.GetProperty("params").GetProperty("dictionaryTerms");
                    if (importedTerms.ValueKind != JsonValueKind.Array) throw new InvalidOperationException("Invalid dictionary.");
                    var importedDictionary = Vocabulary.Normalize(importedTerms.EnumerateArray().Select(term => term.GetString()));
                    Settings.SaveDictionaryTerms(importedDictionary); dictionaryTerms = importedDictionary; learnedEntries.Clear();
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
            correctionObservation?.Cancel(); correctionObservation = null;
            var grokStreaming = TranscriptionModels.IsStreaming(transcriptionModel);
            var effectiveCleanup = cleanupMode;
            if ((grokStreaming && string.IsNullOrWhiteSpace(xaiApiKey))
                || (!grokStreaming && string.IsNullOrWhiteSpace(apiKey))
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
                session = grokStreaming
                    ? new XaiStreamingSession(xaiApiKey, metrics, operation.Token, dictionaryTerms)
                    : new TranscriptionSession(http, apiKey, metrics, operation.Token, dictionaryTerms, transcriptionModel, doubleTranscription);
                var recorderMode = grokStreaming ? RecorderMode.Stream
                    : liveChunks ? RecorderMode.AtPauses : RecorderMode.AtStop;
                recorder = new Recorder(recorderMode);
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
                        var encoded = EncodeAudio(audio, trace, "Fallback · ");
                        var fallback = await CreateModelTranscription(trace, dictionaryTerms).TranscribeWithFallbackAsync(
                            encoded.Bytes, encoded.Format, transcriptionModel, dictionaryTerms, trace, cancellation.Token,
                            skipRequested: !TranscriptionModels.IsStreaming(transcriptionModel)).ConfigureAwait(false);
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
                if (await Paste.IntoAsync(text, target, cancellation.Token, () => { trace.Pasted(); PublishState(); }, trace, TargetContext.AcceptsTextAsync))
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
            if (TranscriptionModels.IsStreaming(transcriptionModel)) XaiTranscription.ValidateKeyterms(next);
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
    private ModelTranscription CreateModelTranscription(SessionMetrics trace, IReadOnlyList<string> dictionary)
    {
        var grokDictionaryCompatible = dictionary.Count <= 100 && dictionary.All(term => term.Length <= 50);
        return new ModelTranscription(async (model, audio, format, terms, token) =>
        {
            if (TranscriptionModels.IsStreaming(model))
                return await new XaiBatchTranscriber(http).TranscribeAsync(audio, format, xaiApiKey, terms, trace, token).ConfigureAwait(false);
            var encoded = string.Equals(format, "wav", StringComparison.OrdinalIgnoreCase) && audio.Length >= 20 * 32000
                ? EncodeAudio(audio, trace, "Fallback · ")
                : (Bytes: audio, Format: format);
            return await new Transcriber(http).TranscribeAsync(encoded.Bytes, apiKey, token, trace,
                $"Fallback {ModelLabel(model)} · ", encoded.Format, terms, model).ConfigureAwait(false);
        }, model => TranscriptionModels.IsStreaming(model)
            ? !string.IsNullOrWhiteSpace(xaiApiKey) && grokDictionaryCompatible
            : !string.IsNullOrWhiteSpace(apiKey));
    }
    private static string ModelLabel(string model) => model switch
    {
        TranscriptionModels.Gpt => "GPT-Transcribe",
        TranscriptionModels.MaiVerbatim => "MAI-Transcribe-2 Verbatim",
        TranscriptionModels.MaiClean => "MAI-Transcribe-2 Clean",
        TranscriptionModels.GrokStreaming => "Grok Voice Transcribe 2.0",
        _ => model
    };
    private static (byte[] Bytes, string Format) EncodeAudio(byte[] wav, SessionMetrics metrics, string prefix = "")
    {
        using (metrics.Measure(prefix + "Compress audio"))
        {
            try { return AudioEncoding.Compress(wav); }
            catch (Exception ex) when (ex is System.Runtime.InteropServices.COMException or InvalidOperationException)
            {
                using (metrics.Measure(prefix + "MP3 unavailable; using WAV")) return (wav, "wav");
            }
        }
    }
    private async Task<object> TranscribeFileAsync(string path, string format, string model, bool useFallback)
    {
        if (!TranscriptionModels.IsValid(model)) throw new InvalidOperationException("Choose a valid transcription model.");
        var fullPath = Path.GetFullPath(path);
        var info = new FileInfo(fullPath);
        if (!info.Exists || info.Length is <= 44 or > 50 * 1024 * 1024) throw new InvalidOperationException("The saved recording is unavailable or invalid.");
        var source = await File.ReadAllBytesAsync(fullPath).ConfigureAwait(false);
        var comparisonMetrics = new SessionMetrics { CleanupMode = CleanupService.Off };
        comparisonMetrics.Audio(Transcriber.EstimateAudioSeconds(source, format), source.Length);
        var encoded = string.Equals(format, "wav", StringComparison.OrdinalIgnoreCase)
            ? EncodeAudio(source, comparisonMetrics)
            : (Bytes: source, Format: format);
        var modelTranscription = CreateModelTranscription(comparisonMetrics, dictionaryTerms);
        var result = useFallback
            ? await modelTranscription.TranscribeWithFallbackAsync(encoded.Bytes, encoded.Format, model, dictionaryTerms, comparisonMetrics, CancellationToken.None).ConfigureAwait(false)
            : await modelTranscription.TranscribeExactAsync(encoded.Bytes, encoded.Format, model, dictionaryTerms, comparisonMetrics, CancellationToken.None).ConfigureAwait(false);
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
        var grok = TranscriptionModels.IsStreaming(saved.TranscriptionModel);
        if (grok && string.IsNullOrWhiteSpace(xaiApiKey)) throw new InvalidOperationException("Add an xAI API key in Settings first.");
        if (!grok && string.IsNullOrWhiteSpace(apiKey)) throw new InvalidOperationException("Add an OpenRouter API key in Settings first.");
        var retryMetrics = new SessionMetrics();
        // Retries skip AI cleanup and paste the raw transcript, so the recorded
        // cleaner is off even when the original attempt used Luna.
        retryMetrics.TranscriptionModel = saved.TranscriptionModel;
        retryMetrics.RequestedTranscriptionModel = saved.TranscriptionModel;
        retryMetrics.CleanupMode = CleanupService.Off;
        (byte[] Bytes, string Format) encoded;
        using (retryMetrics.Measure("Compress audio"))
        {
            try { encoded = AudioEncoding.Compress(saved.Audio); }
            catch (Exception ex) when (ex is System.Runtime.InteropServices.COMException or InvalidOperationException)
            {
                using (retryMetrics.Measure("MP3 unavailable; using WAV")) encoded = (saved.Audio, "wav");
            }
        }
        var text = grok
            ? await new XaiBatchTranscriber(http).TranscribeAsync(encoded.Bytes, encoded.Format, xaiApiKey, saved.Dictionary, retryMetrics, CancellationToken.None).ConfigureAwait(false)
            : await new Transcriber(http).TranscribeAsync(encoded.Bytes, apiKey, CancellationToken.None,
                retryMetrics, "", encoded.Format, saved.Dictionary, saved.TranscriptionModel).ConfigureAwait(false);
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
        exiting = true; correctionObservation?.Cancel(); timer.Stop(); timer.Dispose(); shortcut?.Dispose(); operation?.Cancel(); recorder?.Dispose();
        dispatcher.Dispose(); http.Dispose(); output.Writer.TryComplete(); base.ExitThreadCore();
    }
}
