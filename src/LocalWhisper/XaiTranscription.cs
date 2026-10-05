using System.Net.Http.Headers;
using System.Text.Json;

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
