using System.Net.Http.Headers;
using System.Text.Json;
using System.Net;

namespace LocalWhisper;

public sealed class Transcriber(HttpClient client)
{
    public const string Model = "openai/gpt-transcribe";
    public async Task<string> TranscribeAsync(byte[] wav, string key, CancellationToken cancellation,
        SessionMetrics? metrics = null, string prefix = "", string format = "wav", IReadOnlyList<string>? dictionaryTerms = null)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(TimeSpan.FromSeconds(45));
        cancellation = timeout.Token;
        using var request = new HttpRequestMessage(HttpMethod.Post, "https://openrouter.ai/api/v1/audio/transcriptions");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        request.Headers.Add("X-Title", "Local Whisper");
        HttpContent content;
        using (metrics?.Measure(prefix + "Prepare request"))
        {
            var payload = new Dictionary<string, object>
            {
                ["model"] = Model,
                ["input_audio"] = new { data = Convert.ToBase64String(wav), format }
            };
            if (dictionaryTerms is { Count: > 0 })
                payload["provider"] = new { options = new { openai = new { keywords = dictionaryTerms } } };
            content = new ByteArrayContent(JsonSerializer.SerializeToUtf8Bytes(payload));
        }
        content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        metrics?.RequestSize(content.Headers.ContentLength ?? 0);
        using var transport = metrics?.Measure(prefix + "Connect / send request");
        IDisposable? waiting = null;
        request.Content = new MeasuredContent(content, () => { transport?.Dispose(); return metrics?.Measure(prefix + "Write audio to transport"); },
            () => waiting = metrics?.Measure(prefix + "Wait for response headers"));
        HttpResponseMessage response;
        try { response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation).ConfigureAwait(false); }
        finally { transport?.Dispose(); waiting?.Dispose(); }
        using var responseLifetime = response;
        if (!response.IsSuccessStatusCode)
        {
            var message = (int)response.StatusCode switch
            {
                401 or 403 => "OpenRouter rejected the API key. Check Settings.",
                402 => "Your OpenRouter account needs credits.",
                429 => "OpenRouter is rate limiting requests. Try again shortly.",
                _ => $"Transcription failed (HTTP {(int)response.StatusCode}). Try again."
            };
            throw new HttpRequestException(message);
        }
        using var reading = metrics?.Measure(prefix + "Read / parse transcript");
        using var json = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellation).ConfigureAwait(false), cancellationToken: cancellation).ConfigureAwait(false);
        if (!json.RootElement.TryGetProperty("text", out var text) || text.ValueKind != JsonValueKind.String)
            throw new InvalidDataException("OpenRouter returned no transcript. Try again.");
        return text.GetString()!.Trim();
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
