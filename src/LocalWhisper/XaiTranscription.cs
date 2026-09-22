using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace LocalWhisper;

internal static class XaiTranscription
{
    public const string Model = "grok-voice-transcribe-2.0";
    public static void ValidateKeyterms(IReadOnlyList<string> terms)
    {
        if (terms.Count > 100)
            throw new InvalidOperationException("Grok streaming accepts at most 100 dictionary terms.");
        if (terms.FirstOrDefault(term => term.Length > 50) is { } longTerm)
            throw new InvalidOperationException($"Grok streaming dictionary terms are limited to 50 characters: {longTerm}");
    }
    public static Uri StreamingUri(IReadOnlyList<string> terms)
    {
        ValidateKeyterms(terms);
        var query = new List<string>
        {
            $"model={Uri.EscapeDataString(Model)}", "sample_rate=16000", "encoding=pcm", "interim_results=false"
        };
        query.AddRange(terms.Select(term => "keyterm=" + Uri.EscapeDataString(term)));
        return new Uri("wss://api.x.ai/v1/stt?" + string.Join("&", query));
    }
    public static IEnumerable<byte[]> Frames(IEnumerable<byte[]> chunks, int frameBytes = 3200)
    {
        using var pending = new MemoryStream();
        foreach (var chunk in chunks)
        {
            pending.Position = pending.Length;
            pending.Write(chunk);
            while (pending.Length >= frameBytes)
            {
                var bytes = pending.ToArray();
                yield return bytes[..frameBytes];
                pending.SetLength(0);
                pending.Write(bytes, frameBytes, bytes.Length - frameBytes);
            }
        }
        if (pending.Length > 0) yield return pending.ToArray();
    }
}

internal sealed class XaiStreamingSession : ITranscriptionSession
{
    private readonly Channel<byte[]> audio = Channel.CreateUnbounded<byte[]>(new UnboundedChannelOptions { SingleReader = true });
    private readonly CancellationToken token;
    private readonly SessionMetrics metrics;
    private readonly string key;
    private readonly Uri uri;
    private readonly Task<string> worker;
    private int count, completed, failed;
    private long audioBytes;
    private string? lastError;
    private Exception? failure;
    public int Count => Volatile.Read(ref count);
    public int Completed => Volatile.Read(ref completed);
    public int Failed => Volatile.Read(ref failed);
    public string? LastError => lastError;
    public Exception? Failure => failure;

    public XaiStreamingSession(string key, SessionMetrics metrics, CancellationToken token, IReadOnlyList<string>? dictionaryTerms = null)
    {
        this.key = key; this.metrics = metrics; this.token = token;
        uri = XaiTranscription.StreamingUri(dictionaryTerms ?? []);
        worker = RunAsync();
        _ = worker.ContinueWith(task => _ = task.Exception, TaskContinuationOptions.OnlyOnFaulted);
    }
    public void EnqueuePcm(byte[] pcm)
    {
        if (pcm.Length == 0 || token.IsCancellationRequested || !audio.Writer.TryWrite(pcm)) return;
        Interlocked.Increment(ref count);
        Interlocked.Add(ref audioBytes, pcm.Length);
    }
    public async Task<string> FinishAsync()
    {
        audio.Writer.TryComplete();
        try { return await worker.ConfigureAwait(false); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            lastError = ex.Message; failure = ex; Interlocked.Exchange(ref failed, 1); throw;
        }
    }
    private async Task<string> RunAsync()
    {
        using var socket = new ClientWebSocket();
        socket.Options.SetRequestHeader("Authorization", "Bearer " + key);
        using (metrics.Measure("Connect streaming transcription"))
        {
            await socket.ConnectAsync(uri, token).WaitAsync(TimeSpan.FromSeconds(15), token).ConfigureAwait(false);
            using var created = await ReceiveEventAsync(socket, token).ConfigureAwait(false);
            if (EventType(created) == "error") throw ServerError(created);
            if (EventType(created) != "transcript.created")
                throw new InvalidDataException("Grok did not start the streaming transcription session.");
        }
        var receive = ReceiveTranscriptAsync(socket, finals: []);
        using (metrics.Measure("Stream audio"))
        {
            using var pending = new MemoryStream();
            await foreach (var chunk in audio.Reader.ReadAllAsync(token).ConfigureAwait(false))
            {
                pending.Position = pending.Length;
                pending.Write(chunk);
                while (pending.Length >= 3200)
                {
                    var bytes = pending.ToArray();
                    await SendAudioAsync(socket, bytes.AsMemory(0, 3200)).ConfigureAwait(false);
                    pending.SetLength(0);
                    pending.Write(bytes, 3200, bytes.Length - 3200);
                }
            }
            if (pending.Length > 0) await SendAudioAsync(socket, pending.ToArray()).ConfigureAwait(false);
        }
        using (metrics.Measure("Finalize streaming transcript"))
        {
            var done = Encoding.UTF8.GetBytes("{\"type\":\"audio.done\"}");
            await socket.SendAsync(done, WebSocketMessageType.Text, true, token).ConfigureAwait(false);
            string text;
            try { text = await receive.WaitAsync(TimeSpan.FromSeconds(30), token).ConfigureAwait(false); }
            catch (TimeoutException) { throw new TimeoutException("Grok did not finalize the transcript within 30 seconds."); }
            Interlocked.Exchange(ref completed, 1);
            var seconds = Volatile.Read(ref audioBytes) / 32000m;
            metrics.Cost("voice", XaiTranscription.Model, seconds / 3600m * 0.20m);
            return text;
        }
    }
    private async Task SendAudioAsync(ClientWebSocket socket, ReadOnlyMemory<byte> frame)
    {
        await socket.SendAsync(frame, WebSocketMessageType.Binary, true, token).ConfigureAwait(false);
        metrics.RequestSize(frame.Length);
    }
    private async Task<string> ReceiveTranscriptAsync(ClientWebSocket socket, List<string> finals)
    {
        while (true)
        {
            using var message = await ReceiveEventAsync(socket, token).ConfigureAwait(false);
            switch (EventType(message))
            {
                // With interim_results=false the server still emits locked chunks as
                // partial events with is_final=true while audio streams. Those carry
                // the bulk of the transcript; transcript.done only flushes the tail
                // and its text field is optional, so every final must be kept.
                case "transcript.partial":
                    if (PartialFinalText(message) is { } partial) finals.Add(partial);
                    break;
                case "transcript.done":
                    if (DoneText(message) is { } done) finals.Add(done);
                    return string.Join(" ", finals).Trim();
                case "error": throw ServerError(message);
            }
        }
    }
    internal static string? PartialFinalText(JsonDocument message) =>
        IsFinal(message) ? NonEmptyText(message) : null;
    internal static string? DoneText(JsonDocument message) => NonEmptyText(message);
    private static bool IsFinal(JsonDocument message) =>
        message.RootElement.TryGetProperty("is_final", out var value) && value.ValueKind == JsonValueKind.True;
    private static string? NonEmptyText(JsonDocument message)
    {
        if (!message.RootElement.TryGetProperty("text", out var text) || text.ValueKind != JsonValueKind.String)
            return null;
        var value = text.GetString()!.Trim();
        return value.Length > 0 ? value : null;
    }
    private static string? EventType(JsonDocument message) =>
        message.RootElement.TryGetProperty("type", out var type) ? type.GetString() : null;
    private static HttpRequestException ServerError(JsonDocument message)
    {
        var detail = message.RootElement.TryGetProperty("message", out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() : null;
        if (!string.IsNullOrWhiteSpace(detail))
        {
            detail = string.Join(" ", detail.Split([' ', '\r', '\n', '\t'], StringSplitOptions.RemoveEmptyEntries));
            if (detail.Length > 160) detail = detail[..160] + "…";
        }
        return new HttpRequestException(string.IsNullOrWhiteSpace(detail) ? "Grok streaming transcription failed."
            : "Grok streaming transcription failed: " + detail);
    }
    private static async Task<JsonDocument> ReceiveEventAsync(ClientWebSocket socket, CancellationToken cancellation)
    {
        using var buffer = new MemoryStream();
        var bytes = new byte[8192];
        while (true)
        {
            var result = await socket.ReceiveAsync(bytes, cancellation).ConfigureAwait(false);
            if (result.MessageType == WebSocketMessageType.Close)
                throw new HttpRequestException("Grok closed the streaming connection before returning a transcript.");
            buffer.Write(bytes, 0, result.Count);
            if (result.EndOfMessage) break;
        }
        return JsonDocument.Parse(buffer.ToArray());
    }
}

internal sealed class XaiBatchTranscriber(HttpClient http)
{
    public async Task<string> TranscribeAsync(byte[] audio, string format, string key, IReadOnlyList<string> dictionary,
        SessionMetrics metrics, CancellationToken cancellation)
    {
        XaiTranscription.ValidateKeyterms(dictionary);
        using var request = new HttpRequestMessage(HttpMethod.Post, "https://api.x.ai/v1/stt");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        using var form = new MultipartFormDataContent();
        form.Add(new StringContent(XaiTranscription.Model), "model");
        foreach (var term in dictionary) form.Add(new StringContent(term), "keyterm");
        var file = new ByteArrayContent(audio);
        file.Headers.ContentType = new MediaTypeHeaderValue(format == "mp3" ? "audio/mpeg" : "audio/wav");
        form.Add(file, "file", "audio." + format);
        request.Content = form;
        metrics.RequestSize(audio.Length);
        using var measured = metrics.Measure("Batch retry transcription (Grok)");
        using var response = await http.SendAsync(request, cancellation).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException((int)response.StatusCode is 401 or 403
                ? "xAI rejected the API key. Check Settings."
                : $"Grok transcription failed (HTTP {(int)response.StatusCode}). Try again.");
        using var json = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellation), cancellationToken: cancellation).ConfigureAwait(false);
        if (!json.RootElement.TryGetProperty("text", out var text) || text.ValueKind != JsonValueKind.String)
            throw new InvalidDataException("Grok returned no transcript.");
        var seconds = json.RootElement.TryGetProperty("duration", out var duration) && duration.TryGetDecimal(out var value)
            ? value : (decimal)Transcriber.EstimateAudioSeconds(audio, format);
        metrics.Cost("voice", XaiTranscription.Model, seconds / 3600m * 0.10m);
        return text.GetString()!.Trim();
    }
}
