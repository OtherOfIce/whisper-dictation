using System.Net.WebSockets;
using System.Text.Json;

namespace LocalWhisper.Streaming;

internal interface IStreamingTransport : IDisposable
{
    Task ConnectAsync(Uri uri, IReadOnlyDictionary<string, string> headers, IReadOnlyList<string> protocols, CancellationToken token);
    Task SendAsync(ReadOnlyMemory<byte> bytes, bool text, CancellationToken token);
    Task<JsonDocument> ReceiveAsync(CancellationToken token);
}

internal sealed class StreamingTransport : IStreamingTransport
{
    private readonly ClientWebSocket socket = new();
    public async Task ConnectAsync(Uri uri, IReadOnlyDictionary<string, string> headers, IReadOnlyList<string> protocols, CancellationToken token)
    {
        foreach (var pair in headers) socket.Options.SetRequestHeader(pair.Key, pair.Value);
        foreach (var protocol in protocols) socket.Options.AddSubProtocol(protocol);
        await socket.ConnectAsync(uri, token).ConfigureAwait(false);
    }
    public async Task SendAsync(ReadOnlyMemory<byte> bytes, bool text, CancellationToken token) =>
        await socket.SendAsync(bytes, text ? WebSocketMessageType.Text : WebSocketMessageType.Binary, true, token).ConfigureAwait(false);
    public async Task<JsonDocument> ReceiveAsync(CancellationToken token)
    {
        using var message = new MemoryStream();
        var buffer = new byte[8192];
        while (true)
        {
            var part = await socket.ReceiveAsync(buffer.AsMemory(), token).ConfigureAwait(false);
            if (part.MessageType == WebSocketMessageType.Close)
                throw new HttpRequestException("Streaming connection closed before the completed transcript.");
            if (part.MessageType != WebSocketMessageType.Text || message.Length + part.Count > 256 * 1024)
                throw new InvalidDataException("Invalid streaming transcription event.");
            message.Write(buffer, 0, part.Count);
            if (part.EndOfMessage) return JsonDocument.Parse(message.ToArray());
        }
    }
    public void Dispose() { socket.Abort(); socket.Dispose(); }
}
