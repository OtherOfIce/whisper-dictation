using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using NAudio.Wave;

namespace MuseStreamingPrototype;

public sealed class MuseStreamClient : IAsyncDisposable
{
    public const string Model = "muse-voice-transcribe-1.0";
    public static readonly Uri Endpoint = new("wss://api.meta.ai/v1/asr/realtime");
    private const int SampleRate = 16_000;
    private const int BytesPerSecond = SampleRate * 2;
    private readonly ClientWebSocket socket = new();
    private WaveInEvent? microphone;
    private long sentBytes;
    private long processedMilliseconds;

    public int SentMilliseconds => (int)Math.Min(int.MaxValue, Interlocked.Read(ref sentBytes) * 1000 / BytesPerSecond);
    public int AccountedMilliseconds => Math.Max(SentMilliseconds, (int)Math.Min(int.MaxValue, Interlocked.Read(ref processedMilliseconds)));

    public async Task<string> RunAsync(string key, Guid sessionId, int maximumSeconds, IReadOnlyList<string> keywords,
        bool bearerPrefix, CancellationToken stopRequested)
    {
        if (string.IsNullOrWhiteSpace(key)) throw new InvalidOperationException("Set MODEL_API_KEY before starting a paid stream.");
        using var hardStop = CancellationTokenSource.CreateLinkedTokenSource(stopRequested);
        hardStop.CancelAfter(TimeSpan.FromSeconds(maximumSeconds));

        using var connectTimeout = CancellationTokenSource.CreateLinkedTokenSource(stopRequested);
        connectTimeout.CancelAfter(TimeSpan.FromSeconds(10));
        var endpoint = new Uri($"{Endpoint}?sessionId={Uri.EscapeDataString(sessionId.ToString("N"))}");
        await socket.ConnectAsync(endpoint, connectTimeout.Token).ConfigureAwait(false);
        var handshake = new Dictionary<string, object>
        {
            ["mode"] = "PUSH_TO_TALK",
            ["authorization"] = new { accessToken = bearerPrefix ? $"Bearer {key}" : key },
            ["audioEncoding"] = "PCM_16KHZ",
            ["model"] = Model,
            ["partialMode"] = "CUMULATIVE",
            ["emitAudioProgress"] = true
        };
        if (keywords.Count > 0) handshake["keywords"] = keywords;
        await SendTextAsync(JsonSerializer.Serialize(handshake), connectTimeout.Token).ConfigureAwait(false);

        var acknowledgement = await ReceiveTextAsync(connectTimeout.Token).ConfigureAwait(false);
        using (var json = JsonDocument.Parse(acknowledgement))
        {
            if (json.RootElement.TryGetProperty("type", out var type) && type.GetString() == "error")
                throw new InvalidOperationException(SafeServerError(json.RootElement));
            if (!json.RootElement.TryGetProperty("sessionId", out _))
                throw new InvalidDataException("Meta did not acknowledge the streaming session.");
        }

        var audio = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(2)
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = true,
            SingleWriter = true
        });
        var overflow = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var stopped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        microphone = new WaveInEvent { DeviceNumber = -1, WaveFormat = new WaveFormat(SampleRate, 16, 1), BufferMilliseconds = 80 };
        microphone.DataAvailable += (_, eventArgs) =>
        {
            var frame = eventArgs.Buffer.AsSpan(0, eventArgs.BytesRecorded).ToArray();
            if (!audio.Writer.TryWrite(frame)) overflow.TrySetResult();
        };
        microphone.RecordingStopped += (_, eventArgs) =>
        {
            audio.Writer.TryComplete(eventArgs.Exception);
            if (eventArgs.Exception is null) stopped.TrySetResult();
            else stopped.TrySetException(eventArgs.Exception);
        };

        Console.Error.WriteLine("Listening. Press Enter or Ctrl+C to stop.");
        var transcriptTask = ReceiveTranscriptsAsync();
        var sendTask = SendAudioAsync(audio.Reader);
        microphone.StartRecording();
        var enter = Task.Run(Console.ReadLine);
        var limit = Task.Delay(Timeout.InfiniteTimeSpan, hardStop.Token).ContinueWith(_ => { }, TaskScheduler.Default);
        var reason = await Task.WhenAny(enter, limit, overflow.Task, transcriptTask, sendTask).ConfigureAwait(false);
        microphone.StopRecording();
        await stopped.Task.WaitAsync(TimeSpan.FromSeconds(3)).ConfigureAwait(false);

        if (reason == overflow.Task || reason == transcriptTask && transcriptTask.IsFaulted || reason == sendTask && sendTask.IsFaulted)
        {
            socket.Abort();
            if (reason == transcriptTask) return await transcriptTask.ConfigureAwait(false);
            if (reason == sendTask) await sendTask.ConfigureAwait(false);
            throw new IOException("The two-frame microphone buffer filled. The stream was stopped before a delayed backlog could increase cost.");
        }

        await sendTask.ConfigureAwait(false);
        using var endTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        await SendTextAsync("{\"type\":\"endStream\"}", endTimeout.Token).ConfigureAwait(false);
        try { return await transcriptTask.WaitAsync(TimeSpan.FromSeconds(15)).ConfigureAwait(false); }
        catch (TimeoutException)
        {
            socket.Abort();
            throw new TimeoutException("Meta did not finish the transcript within 15 seconds. The socket was aborted.");
        }
    }

    private async Task SendAudioAsync(ChannelReader<byte[]> audio)
    {
        await foreach (var frame in audio.ReadAllAsync().ConfigureAwait(false))
        {
            using var sendTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            await socket.SendAsync(frame, WebSocketMessageType.Binary, true, sendTimeout.Token).ConfigureAwait(false);
            Interlocked.Add(ref sentBytes, frame.Length);
        }
    }

    private async Task<string> ReceiveTranscriptsAsync()
    {
        var latest = "";
        while (socket.State is WebSocketState.Open or WebSocketState.CloseSent)
        {
            var message = await ReceiveTextAsync(CancellationToken.None).ConfigureAwait(false);
            using var json = JsonDocument.Parse(message);
            var root = json.RootElement;
            if (root.TryGetProperty("audioProcessedMs", out var progress) && progress.TryGetInt64(out var milliseconds))
                Interlocked.Exchange(ref processedMilliseconds, Math.Max(milliseconds, Interlocked.Read(ref processedMilliseconds)));
            if (root.TryGetProperty("type", out var type) && type.GetString() == "error")
                throw new InvalidOperationException(SafeServerError(root));
            if (!root.TryGetProperty("type", out type) || type.GetString() != "transcript") continue;
            if (!root.TryGetProperty("transcript", out var value) || value.ValueKind != JsonValueKind.String) continue;
            latest = value.GetString() ?? "";
            var final = root.TryGetProperty("final", out var finalValue) && finalValue.ValueKind == JsonValueKind.True;
            Console.Write($"\r{latest[..Math.Min(latest.Length, 100)]}{(final ? Environment.NewLine : "")}");
            if (final) return latest.Trim();
        }
        throw new IOException("Meta closed the socket before returning a final transcript.");
    }

    private async Task SendTextAsync(string value, CancellationToken cancellationToken)
    {
        var bytes = Encoding.UTF8.GetBytes(value);
        await socket.SendAsync(bytes, WebSocketMessageType.Text, true, cancellationToken).ConfigureAwait(false);
    }

    private async Task<string> ReceiveTextAsync(CancellationToken cancellationToken)
    {
        using var body = new MemoryStream();
        var buffer = new byte[4096];
        WebSocketReceiveResult result;
        do
        {
            result = await socket.ReceiveAsync(buffer, cancellationToken).ConfigureAwait(false);
            if (result.MessageType == WebSocketMessageType.Close)
                throw new IOException($"Meta closed the stream ({(int?)result.CloseStatus ?? 0}).");
            if (result.MessageType != WebSocketMessageType.Text)
                throw new InvalidDataException("Meta returned an unexpected binary message.");
            body.Write(buffer, 0, result.Count);
            if (body.Length > 1_048_576) throw new InvalidDataException("Meta returned an oversized event.");
        } while (!result.EndOfMessage);
        return Encoding.UTF8.GetString(body.ToArray());
    }

    private static string SafeServerError(JsonElement root)
    {
        // Do not surface an arbitrary server message. A rejected handshake
        // could quote request data, which includes the API key.
        return "Meta rejected the stream. Check the key and handshake settings.";
    }

    public async ValueTask DisposeAsync()
    {
        microphone?.Dispose();
        if (socket.State == WebSocketState.Open)
        {
            using var closeTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            try { await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "client finished", closeTimeout.Token).ConfigureAwait(false); }
            catch { socket.Abort(); }
        }
        socket.Dispose();
    }
}
