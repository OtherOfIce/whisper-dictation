using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Net;

namespace LocalWhisper;

public static class TranscriptionModels
{
    public const string Gpt = "gpt-transcribe";
    public const string MaiVerbatim = "mai-transcribe-2-verbatim";
    public const string MaiClean = "mai-transcribe-2-clean";
    public const string GrokStreaming = "grok-voice-transcribe-2-streaming";
    public static bool IsValid(string value) => value is Gpt or MaiVerbatim or MaiClean or GrokStreaming;
    public static bool IsMai(string value) => value is MaiVerbatim or MaiClean;
    public static bool IsStreaming(string value) => value == GrokStreaming;
}

public sealed class Transcriber(HttpClient client)
{
    public const string Model = "openai/gpt-transcribe";
    public const string MaiModel = "microsoft/mai-transcribe-2";
    internal Func<double, TimeSpan> HedgeDelay = DefaultHedgeDelay;
    internal Func<double, TimeSpan> ParallelFallbackDelay = DefaultHedgeDelay;
    internal Func<int, TimeSpan> RetryBackoff = DefaultRetryBackoff;
    internal static TimeSpan DefaultHedgeDelay(double audioSeconds) =>
        TimeSpan.FromMilliseconds(Math.Min(2500 + 50 * Math.Max(0, audioSeconds), 10000));
    internal static TimeSpan DefaultRetryBackoff(int failedAttempt) =>
        TimeSpan.FromSeconds(Math.Min(Math.Pow(2, Math.Max(0, failedAttempt)), 8));
    internal static bool IsRetryableStatus(HttpStatusCode status) => status is HttpStatusCode.RequestTimeout
        or HttpStatusCode.TooManyRequests or HttpStatusCode.InternalServerError or HttpStatusCode.BadGateway
        or HttpStatusCode.ServiceUnavailable or HttpStatusCode.GatewayTimeout;
    internal static bool IsRetryable(HttpRequestException ex) =>
        ex.StatusCode is { } status ? IsRetryableStatus(status) : true;
    internal static double EstimateAudioSeconds(byte[] audio, string format)
    {
        try
        {
            if (string.Equals(format, "wav", StringComparison.OrdinalIgnoreCase))
                return WavSeconds(audio);
        }
        catch { }
        var seconds = audio.Length * 8.0 / 48000;
        return seconds > 0 ? seconds : 5;
    }
    private static double WavSeconds(byte[] audio)
    {
        var offset = 12;
        int? byteRate = null;
        while (offset + 8 <= audio.Length)
        {
            var id = System.Text.Encoding.ASCII.GetString(audio, offset, 4);
            var size = BitConverter.ToInt32(audio, offset + 4);
            if (size < 0 || offset + 8 + size > audio.Length) break;
            if (id == "fmt " && size >= 16)
                byteRate = BitConverter.ToInt32(audio, offset + 8 + 8);
            if (id == "data" && byteRate is > 0)
                return size / (double)byteRate.Value;
            offset += 8 + size + (size % 2);
        }
        throw new InvalidDataException("No data chunk found.");
    }
    internal sealed class RetryableTranscriptionException(string message, HttpStatusCode? status, double? retryAfterMs)
        : HttpRequestException(message, null, status)
    {
        public double? RetryAfterMs { get; } = retryAfterMs;
    }
    internal static double? RetryAfterMs(HttpResponseMessage response)
    {
        try
        {
            if (response.Headers.RetryAfter?.Delta is { } delta)
                return Math.Min(Math.Max(0, delta.TotalMilliseconds), 20000);
            if (response.Headers.RetryAfter?.Date is { } date)
                return Math.Min(Math.Max(0, (date - DateTimeOffset.UtcNow).TotalMilliseconds), 20000);
            if (response.Headers.TryGetValues("X-RateLimit-Reset", out var values)
                && long.TryParse(values.FirstOrDefault(), out var resetUnix))
                return Math.Min(Math.Max(0, (DateTimeOffset.FromUnixTimeSeconds(resetUnix) - DateTimeOffset.UtcNow).TotalMilliseconds), 20000);
        }
        catch { }
        return null;
    }
    public async Task<string> TranscribeAsync(byte[] wav, string key, CancellationToken cancellation,
        SessionMetrics? metrics = null, string prefix = "", string format = "wav", IReadOnlyList<string>? dictionaryTerms = null,
        string transcriptionModel = TranscriptionModels.MaiClean, bool doubleTranscription = false)
    {
        if (!TranscriptionModels.IsValid(transcriptionModel) || TranscriptionModels.IsStreaming(transcriptionModel))
            throw new InvalidOperationException("Invalid file transcription model.");
        var userCancellation = cancellation;
        byte[] payloadBytes;
        using (metrics?.Measure(prefix + "Prepare request"))
            payloadBytes = BuildPayload(wav, format, dictionaryTerms, transcriptionModel);
        if (doubleTranscription && TranscriptionModels.IsMai(transcriptionModel))
            return await TranscribeParallelAsync(payloadBytes, wav, format, key, dictionaryTerms, transcriptionModel,
                metrics, prefix, userCancellation).ConfigureAwait(false);
        double? retryHintMs = null;
        for (var attempt = 0; ; attempt++)
        {
            if (attempt > 0)
            {
                var backoff = RetryBackoff(attempt - 1).TotalMilliseconds;
                var waitMs = Math.Min(Math.Max(backoff, retryHintMs ?? 0), 20000);
                using (metrics?.Measure(prefix + $"Retry wait {attempt}"))
                {
                    try { await Task.Delay(TimeSpan.FromMilliseconds(waitMs), userCancellation).ConfigureAwait(false); }
                    catch (OperationCanceledException) when (userCancellation.IsCancellationRequested) { throw; }
                }
            }
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(userCancellation);
            timeout.CancelAfter(TimeSpan.FromSeconds(45));
            try
            {
                return await TranscribeOnceWithHedgeAsync(payloadBytes, wav, format, key, transcriptionModel, metrics, prefix, timeout.Token).ConfigureAwait(false);
            }
            catch (RetryableTranscriptionException ex) when (attempt < 2)
            {
                retryHintMs = ex.RetryAfterMs;
            }
            catch (HttpRequestException ex) when (IsRetryable(ex) && attempt < 2)
            {
                retryHintMs = null;
            }
            catch (OperationCanceledException) when (!userCancellation.IsCancellationRequested && attempt < 2)
            {
                retryHintMs = null;
            }
        }
    }
    private static byte[] BuildPayload(byte[] audio, string format, IReadOnlyList<string>? dictionaryTerms, string transcriptionModel)
    {
        var payload = new Dictionary<string, object>
        {
            ["model"] = TranscriptionModels.IsMai(transcriptionModel) ? MaiModel : Model,
            ["input_audio"] = new { data = Convert.ToBase64String(audio), format }
        };
        if (TranscriptionModels.IsMai(transcriptionModel))
        {
            var azure = new Dictionary<string, object>
            {
                ["enhancedMode"] = new { modelOptions = new { transcribeStyle = transcriptionModel == TranscriptionModels.MaiClean ? "clean" : "verbatim" } }
            };
            if (dictionaryTerms is { Count: > 0 }) azure["phraseList"] = new { phrases = dictionaryTerms };
            payload["provider"] = new { options = new { azure } };
        }
        else if (dictionaryTerms is { Count: > 0 })
            payload["provider"] = new { options = new { openai = new { keywords = dictionaryTerms } } };
        return JsonSerializer.SerializeToUtf8Bytes(payload);
    }
    private sealed record ParallelResult(int Attempt, string Model, string? Text, Exception? Error);
    private async Task<string> TranscribeParallelAsync(byte[] payload, byte[] audio, string format, string key,
        IReadOnlyList<string>? dictionary, string model, SessionMetrics? metrics, string prefix, CancellationToken cancellation)
    {
        var raceId = Guid.NewGuid().ToString("N");
        var sources = new List<CancellationTokenSource>();
        var registrations = new List<CancellationTokenRegistration>();
        var requests = new List<Task<ParallelResult>>();
        Task<ParallelResult> Start(int number, string requestModel, byte[] bytes)
        {
            var source = new CancellationTokenSource(TimeSpan.FromSeconds(45));
            sources.Add(source);
            registrations.Add(cancellation.Register(source.Cancel));
            var task = Run(number, requestModel, bytes, source.Token);
            requests.Add(task);
            return task;
        }
        async Task<ParallelResult> Run(int number, string requestModel, byte[] bytes, CancellationToken token)
        {
            var watch = Stopwatch.StartNew();
            try
            {
                var (text, _) = await SendOnceAsync(bytes, key, requestModel, metrics,
                    prefix + $"Race {number} · ", token).ConfigureAwait(false);
                metrics?.ParallelRequest(new(raceId, number, requestModel, watch.Elapsed.TotalMilliseconds, "Completed", false));
                return new(number, requestModel, text, null);
            }
            catch (Exception ex)
            {
                metrics?.ParallelRequest(new(raceId, number, requestModel, watch.Elapsed.TotalMilliseconds,
                    ex is OperationCanceledException ? "Timed out or cancelled" : "Failed", false));
                return new(number, requestModel, null, ex);
            }
        }
        _ = Start(1, model, payload);
        _ = Start(2, model, payload);
        var pending = new List<Task<ParallelResult>>(requests);
        var delay = ParallelFallbackDelay(EstimateAudioSeconds(audio, format));
        Task? fallbackTimer = delay > TimeSpan.Zero ? Task.Delay(delay, cancellation) : Task.CompletedTask;
        Exception? failure = null;
        var detached = false;
        try
        {
            while (pending.Count > 0)
            {
                var candidates = pending.Cast<Task>().ToList();
                if (fallbackTimer is not null) candidates.Add(fallbackTimer);
                var completed = await Task.WhenAny(candidates).ConfigureAwait(false);
                cancellation.ThrowIfCancellationRequested();
                if (completed == fallbackTimer)
                {
                    fallbackTimer = null;
                    if (pending.Count == 2 && pending.All(task => !task.IsCompleted))
                        pending.Add(Start(3, TranscriptionModels.Gpt, BuildPayload(audio, format, dictionary, TranscriptionModels.Gpt)));
                    continue;
                }
                var finished = (Task<ParallelResult>)completed;
                pending.Remove(finished);
                var result = await finished.ConfigureAwait(false);
                if (result.Text is { Length: > 0 } text)
                {
                    metrics?.SelectParallelRequest(raceId, result.Attempt);
                    if (result.Model == TranscriptionModels.Gpt)
                    {
                        if (metrics is not null) metrics.TranscriptionModel = TranscriptionModels.Gpt;
                        metrics?.Fallback(model, "Both parallel MAI requests were slow; GPT finished first.");
                    }
                    foreach (var registration in registrations) registration.Dispose();
                    var remaining = Task.WhenAll(requests);
                    var observer = remaining.ContinueWith(_ => { foreach (var source in sources) source.Dispose(); }, TaskScheduler.Default);
                    metrics?.TrackBackground(observer);
                    detached = true;
                    return text;
                }
                failure = result.Error;
                fallbackTimer = null; // A failed request is no longer a slow request.
            }
            throw failure ?? new InvalidDataException("Every parallel transcription request failed.");
        }
        finally
        {
            if (!detached)
            {
                foreach (var registration in registrations) registration.Dispose();
                foreach (var source in sources) source.Cancel();
                var observer = Task.WhenAll(requests).ContinueWith(_ => { foreach (var source in sources) source.Dispose(); }, TaskScheduler.Default);
                metrics?.TrackBackground(observer);
            }
        }
    }
    private async Task<string> TranscribeOnceWithHedgeAsync(byte[] payloadBytes, byte[] wav, string format, string key,
        string transcriptionModel, SessionMetrics? metrics, string prefix, CancellationToken cancellation)
    {
        var attempt1Cts = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        var registration1 = cancellation.Register(attempt1Cts.Cancel);
        var attempt1 = SendOnceAsync(payloadBytes, key, transcriptionModel, metrics, prefix, attempt1Cts.Token);
        var hedgeAfter = HedgeDelay(EstimateAudioSeconds(wav, format));
        if (hedgeAfter <= TimeSpan.Zero)
        {
            try { return (await attempt1.ConfigureAwait(false)).Text; }
            finally { registration1.Dispose(); attempt1Cts.Dispose(); }
        }
        using var delayCts = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        var hedgeTimer = Task.Delay(hedgeAfter, delayCts.Token);
        if (await Task.WhenAny(attempt1, hedgeTimer).ConfigureAwait(false) == attempt1)
        {
            delayCts.Cancel();
            try { return (await attempt1.ConfigureAwait(false)).Text; }
            finally { registration1.Dispose(); attempt1Cts.Dispose(); }
        }
        if (cancellation.IsCancellationRequested)
        {
            try { await attempt1.ConfigureAwait(false); } catch { }
            registration1.Dispose(); attempt1Cts.Dispose();
            cancellation.ThrowIfCancellationRequested();
        }
        var attempt2Cts = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        var registration2 = cancellation.Register(attempt2Cts.Cancel);
        var attempt2 = SendOnceAsync(payloadBytes, key, transcriptionModel, metrics, prefix + "Hedge ", attempt2Cts.Token);
        var detached = false;
        try
        {
            var pending = new List<Task<(string Text, double ElapsedMs)>> { attempt1, attempt2 };
            Exception? failure = null;
            while (pending.Count > 0)
            {
                var finished = await Task.WhenAny(pending).ConfigureAwait(false);
                pending.Remove(finished);
                try
                {
                    var (text, winnerMs) = await finished.ConfigureAwait(false);
                    var winnerNumber = finished == attempt1 ? 1 : 2;
                    registration1.Dispose(); registration2.Dispose();
                    var loser = finished == attempt1 ? attempt2 : attempt1;
                    var observer = loser.ContinueWith(task =>
                    {
                        double? loserMs = task.IsCompletedSuccessfully ? task.Result.ElapsedMs : null;
                        metrics?.Hedge(hedgeAfter.TotalMilliseconds, winnerNumber, winnerMs, loserMs,
                            loserMs.HasValue ? loserMs - winnerMs : null);
                        attempt1Cts.Dispose(); attempt2Cts.Dispose();
                    }, TaskScheduler.Default);
                    metrics?.TrackBackground(observer);
                    detached = true;
                    return text;
                }
                catch (Exception ex)
                {
                    failure = ex;
                }
            }
            throw failure ?? new InvalidDataException("Both transcription requests failed.");
        }
        finally
        {
            if (!detached)
            {
                registration1.Dispose(); registration2.Dispose();
                attempt1Cts.Cancel(); attempt2Cts.Cancel();
                var observer = Task.WhenAll(attempt1.ContinueWith(_ => { }), attempt2.ContinueWith(_ => { }))
                    .ContinueWith(_ => { attempt1Cts.Dispose(); attempt2Cts.Dispose(); });
                metrics?.TrackBackground(observer);
            }
        }
    }
    private async Task<(string Text, double ElapsedMs)> SendOnceAsync(byte[] payloadBytes, string key, string transcriptionModel,
        SessionMetrics? metrics, string prefix, CancellationToken cancellation)
    {
        var watch = Stopwatch.StartNew();
        var outcome = "Failed";
        try
        {
        metrics?.RequestSize(payloadBytes.Length);
        using var request = new HttpRequestMessage(HttpMethod.Post, "https://openrouter.ai/api/v1/audio/transcriptions");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        request.Headers.Add("X-Title", "Local Whisper");
        HttpContent content = new ByteArrayContent(payloadBytes);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        using var transport = metrics?.Measure(prefix + "Connect / send request");
        IDisposable? waiting = null;
        request.Content = new MeasuredContent(content, () => { transport?.Dispose(); return metrics?.Measure(prefix + "Write audio to transport"); },
            () => waiting = metrics?.Measure(prefix + "Transcribe audio"));
        HttpResponseMessage response;
        try { response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation).ConfigureAwait(false); }
        finally { transport?.Dispose(); waiting?.Dispose(); }
        using var responseLifetime = response;
        if (!response.IsSuccessStatusCode)
        {
            var detail = await ReadErrorDetailAsync(response, cancellation).ConfigureAwait(false);
            var message = (int)response.StatusCode switch
            {
                401 or 403 => "OpenRouter rejected the API key. Check Settings.",
                402 => "Your OpenRouter account needs credits.",
                // Paid models have no platform request cap, but the upstream provider
                // can still throttle or run out of capacity at peak times.
                429 => "OpenRouter is rate limiting requests. Try again shortly.",
                500 or 502 or 503 or 504 => $"Transcription is temporarily unavailable (HTTP {(int)response.StatusCode}). Try again shortly.",
                _ => $"Transcription failed (HTTP {(int)response.StatusCode}). Try again."
            };
            if (!string.IsNullOrEmpty(detail) && response.StatusCode is not HttpStatusCode.Unauthorized and not HttpStatusCode.Forbidden)
                message += $" ({detail})";
            if (IsRetryableStatus(response.StatusCode))
                throw new RetryableTranscriptionException(message, response.StatusCode, RetryAfterMs(response));
            throw new HttpRequestException(message, null, response.StatusCode);
        }
        using var reading = metrics?.Measure(prefix + "Read / parse transcript");
        using var json = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellation).ConfigureAwait(false), cancellationToken: cancellation).ConfigureAwait(false);
        if (!json.RootElement.TryGetProperty("text", out var text) || text.ValueKind != JsonValueKind.String)
            throw new InvalidDataException("OpenRouter returned no transcript. Try again.");
        var transcript = text.GetString()!.Trim();
        if (transcript.Length == 0)
            throw new RetryableTranscriptionException("The selected model returned no transcript.", null, null);
        var root = json.RootElement;
        var usage = root.TryGetProperty("usage", out var usageValue) ? usageValue : default;
        metrics?.Cost("voice", TranscriptionModels.IsMai(transcriptionModel) ? MaiModel : Model,
            usage.ValueKind == JsonValueKind.Object && usage.TryGetProperty("cost", out var cost) && cost.TryGetDecimal(out var amount) ? amount : null);
        outcome = "Completed";
        return (transcript, watch.Elapsed.TotalMilliseconds);
        }
        catch (OperationCanceledException) { outcome = "Cancelled or timed out"; throw; }
        finally { metrics?.Request(TranscriptionModels.IsMai(transcriptionModel) ? MaiModel : Model, watch.Elapsed.TotalMilliseconds, outcome); }
    }

    private static async Task<string?> ReadErrorDetailAsync(HttpResponseMessage response, CancellationToken cancellation)
    {
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
            cts.CancelAfter(TimeSpan.FromSeconds(5));
            var body = await response.Content.ReadAsStringAsync(cts.Token).ConfigureAwait(false);
            if (string.IsNullOrWhiteSpace(body)) return null;
            try
            {
                using var json = JsonDocument.Parse(body);
                if (json.RootElement.TryGetProperty("error", out var error))
                {
                    if (error.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(error.GetString()))
                        return TruncateDetail(error.GetString()!);
                    if (error.ValueKind == JsonValueKind.Object && error.TryGetProperty("message", out var message)
                        && message.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(message.GetString()))
                        return TruncateDetail(message.GetString()!);
                }
                if (json.RootElement.TryGetProperty("message", out var topMessage)
                    && topMessage.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(topMessage.GetString()))
                    return TruncateDetail(topMessage.GetString()!);
            }
            catch (JsonException) { return TruncateDetail(body); }
            return null;
        }
        catch { return null; }
    }
    private static string TruncateDetail(string detail)
    {
        detail = string.Join(" ", detail.Split([' ', '\r', '\n', '\t'], StringSplitOptions.RemoveEmptyEntries));
        return detail.Length > 160 ? detail[..160] + "…" : detail;
    }

    private sealed class MeasuredContent : HttpContent
    {
        private readonly HttpContent inner;
        private readonly Func<IDisposable?> started;
        private readonly Action finished;
        public MeasuredContent(HttpContent inner, Func<IDisposable?> started, Action finished)
        {
            this.inner = inner; this.started = started; this.finished = finished;
            foreach (var header in inner.Headers) Headers.TryAddWithoutValidation(header.Key, header.Value);
        }
        protected override bool TryComputeLength(out long length) { length = inner.Headers.ContentLength ?? 0; return inner.Headers.ContentLength.HasValue; }
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) => SerializeToStreamAsync(stream, context, CancellationToken.None);
        protected override async Task SerializeToStreamAsync(Stream stream, TransportContext? context, CancellationToken cancellationToken)
        {
            using (started()) await inner.CopyToAsync(stream, context, cancellationToken).ConfigureAwait(false);
            finished();
        }
        protected override void Dispose(bool disposing) { if (disposing) inner.Dispose(); base.Dispose(disposing); }
    }
}
