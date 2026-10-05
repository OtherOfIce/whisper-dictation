using System.Text.Json;

namespace LocalWhisper.Streaming;

internal sealed record StreamingEvent(string? Text = null, bool Completed = false, bool Transcript = false);

internal interface IStreamingProtocol
{
    string Model { get; }
    int FrameBytes { get; }
    decimal PricePerHour { get; }
    Task ConnectAsync(IStreamingTransport transport, CancellationToken token);
    Task CompleteInputAsync(IStreamingTransport transport, CancellationToken token);
    StreamingEvent Read(JsonDocument message);
}

internal sealed class GrokStreamingProtocol(string key, IReadOnlyList<string> dictionary) : IStreamingProtocol
{
    private readonly List<string> finals = [];
    public string Model => XaiTranscription.Model;
    public int FrameBytes => 3200;
    public decimal PricePerHour => 0.20m;
    public async Task ConnectAsync(IStreamingTransport transport, CancellationToken token)
    {
        await transport.ConnectAsync(XaiTranscription.StreamingUri(dictionary),
            new Dictionary<string, string> { ["Authorization"] = "Bearer " + key }, [], token).ConfigureAwait(false);
        using var created = await transport.ReceiveAsync(token).ConfigureAwait(false);
        if (StreamingJson.Type(created) == "error") throw new HttpRequestException("Grok rejected the streaming session. Check your key, credit and connection.");
        if (StreamingJson.Type(created) != "transcript.created") throw new InvalidDataException("Grok did not start the streaming transcription session.");
    }
    public Task CompleteInputAsync(IStreamingTransport transport, CancellationToken token) =>
        transport.SendAsync(JsonSerializer.SerializeToUtf8Bytes(new { type = "audio.done" }), true, token);
    public StreamingEvent Read(JsonDocument message)
    {
        var type = StreamingJson.Type(message);
        if (type == "error") throw new HttpRequestException("Grok streaming transcription failed. Check your key, credit and connection.");
        var text = StreamingJson.Text(message, "text");
        if (type == "transcript.partial" && message.RootElement.TryGetProperty("is_final", out var final) && final.ValueKind == JsonValueKind.True)
        {
            if (!string.IsNullOrWhiteSpace(text)) finals.Add(text.Trim());
            return new(Transcript: !string.IsNullOrWhiteSpace(text));
        }
        if (type != "transcript.done") return new(Transcript: type == "transcript.partial" && !string.IsNullOrWhiteSpace(text));
        if (!string.IsNullOrWhiteSpace(text)) finals.Add(text.Trim());
        return new(string.Join(" ", finals), Completed: true, Transcript: true);
    }
}

internal sealed class GatewayStreamingProtocol(string key) : IStreamingProtocol
{
    public const string ModelId = "microsoft/mai-transcribe-2-streaming";
    public string Model => ModelId;
    public int FrameBytes => 1280;
    public decimal PricePerHour => 0.54m;
    public async Task ConnectAsync(IStreamingTransport transport, CancellationToken token)
    {
        await transport.ConnectAsync(new Uri("wss://ai-gateway.vercel.sh/v4/ai/transcription-model?ai-model-id=" + Uri.EscapeDataString(Model)),
            new Dictionary<string, string>(), ["ai-gateway-transcription.v1", "ai-gateway-auth." + key], token).ConfigureAwait(false);
        await transport.SendAsync(JsonSerializer.SerializeToUtf8Bytes(new
        {
            type = "transcription-stream.start", inputAudioFormat = new { type = "audio/pcm", rate = 16000 }
        }), true, token).ConfigureAwait(false);
    }
    public Task CompleteInputAsync(IStreamingTransport transport, CancellationToken token) =>
        transport.SendAsync(JsonSerializer.SerializeToUtf8Bytes(new { type = "transcription-stream.audio-done" }), true, token);
    public StreamingEvent Read(JsonDocument message)
    {
        var type = StreamingJson.Type(message);
        if (type == "error") throw new HttpRequestException("Vercel AI Gateway streaming failed. Check your key, credit and model access.");
        if (type == "finish")
        {
            var text = StreamingJson.Text(message, "text") ?? throw new InvalidDataException("Vercel AI Gateway returned no completed transcript.");
            return new(text, Completed: true, Transcript: true);
        }
        var transcript = type is "transcript-partial" or "transcript-final" or "transcript-delta";
        return new(Transcript: transcript && !string.IsNullOrWhiteSpace(StreamingJson.Text(message, type == "transcript-delta" ? "delta" : "text")));
    }
}

internal static class StreamingJson
{
    internal static string? Type(JsonDocument message) => Text(message, "type");
    internal static string? Text(JsonDocument message, string name) =>
        message.RootElement.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}
