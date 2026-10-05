using LocalWhisper.Streaming;
using NAudio.Wave;

namespace LocalWhisper;

internal sealed record TranscriptionCredentials(string OpenRouter, string Xai, string Gateway)
{
    internal string For(string model) => TranscriptionModels.Describe(model).Credential switch
    {
        "xai" => Xai, "gateway" => Gateway, _ => OpenRouter
    };
}

// The only application module that maps a selection to live or recorded execution.
internal sealed class TranscriptionPipeline(HttpClient http, TranscriptionCredentials credentials,
    Func<IStreamingTransport>? streamingTransportFactory = null)
{
    internal bool Available(string model, IReadOnlyList<string> dictionary)
    {
        if (string.IsNullOrWhiteSpace(credentials.For(model))) return false;
        try { TranscriptionModels.ValidateDictionary(model, dictionary); return true; }
        catch (InvalidOperationException) { return false; }
    }
    internal (ITranscriptionSession Session, RecorderMode Mode) CreateSession(string model, bool liveChunks,
        bool doubleTranscription, IReadOnlyList<string> dictionary, SessionMetrics metrics, CancellationToken token)
    {
        if (!Available(model, dictionary)) throw new InvalidOperationException("Check the selected model's key and dictionary in Settings.");
        if (TranscriptionModels.IsStreaming(model)) return (CreateStreaming(model, dictionary, metrics, token), RecorderMode.Stream);
        return (new TranscriptionSession(http, credentials.OpenRouter, metrics, token, dictionary, model, doubleTranscription),
            liveChunks ? RecorderMode.AtPauses : RecorderMode.AtStop);
    }
    private StreamingSession CreateStreaming(string model, IReadOnlyList<string> dictionary, SessionMetrics metrics, CancellationToken token) =>
        new(model switch
        {
            TranscriptionModels.GrokStreaming => new GrokStreamingProtocol(credentials.Xai, dictionary),
            TranscriptionModels.MaiStreaming => new GatewayStreamingProtocol(credentials.Gateway),
            _ => throw new InvalidOperationException("Choose a streaming model.")
        }, metrics, token, streamingTransportFactory);

    internal ModelTranscription Recorded(SessionMetrics metrics, IReadOnlyList<string> dictionary) =>
        new((model, audio, format, terms, token) => TranscribeRecordedAsync(model, audio, format, terms, metrics, token),
            model => Available(model, dictionary));

    private async Task<string> TranscribeRecordedAsync(string model, byte[] audio, string format,
        IReadOnlyList<string> dictionary, SessionMetrics metrics, CancellationToken token)
    {
        if (model == TranscriptionModels.MaiStreaming)
        {
            // Saved audio executes this exact model, including on alternate transcripts.
            var pcm = await Task.Run(() => DecodePcm(audio, format), token).ConfigureAwait(false);
            var session = CreateStreaming(model, dictionary, metrics, token);
            await session.ReplayAsync(pcm).ConfigureAwait(false);
            return await session.FinishAsync().ConfigureAwait(false);
        }
        var encoded = format.Equals("wav", StringComparison.OrdinalIgnoreCase) ? Encode(audio, metrics) : (Bytes: audio, Format: format);
        if (model == TranscriptionModels.GrokStreaming)
            return await new XaiBatchTranscriber(http).TranscribeAsync(encoded.Bytes, encoded.Format, credentials.Xai, dictionary, metrics, token).ConfigureAwait(false);
        return await new Transcriber(http).TranscribeAsync(encoded.Bytes, credentials.OpenRouter, token, metrics,
            "", encoded.Format, dictionary, model).ConfigureAwait(false);
    }
    private static (byte[] Bytes, string Format) Encode(byte[] audio, SessionMetrics metrics)
    {
        using var stage = metrics.Measure("Compress audio");
        try { return AudioEncoding.Compress(audio); }
        catch (Exception ex) when (ex is System.Runtime.InteropServices.COMException or InvalidOperationException)
        { return (audio, "wav"); }
    }
    private static byte[] DecodePcm(byte[] audio, string format)
    {
        using var memory = new MemoryStream(audio, writable: false);
        using WaveStream reader = format.ToLowerInvariant() switch
        {
            "wav" => new WaveFileReader(memory),
            "mp3" => new Mp3FileReader(memory),
            _ => throw new InvalidDataException("Saved streaming audio must be WAV or MP3.")
        };
        if (reader.WaveFormat.Encoding == WaveFormatEncoding.Pcm && reader.WaveFormat.SampleRate == 16000
            && reader.WaveFormat.BitsPerSample == 16 && reader.WaveFormat.Channels == 1)
        {
            using var pcm = new MemoryStream(); reader.CopyTo(pcm); return pcm.ToArray();
        }
        using var resampler = new MediaFoundationResampler(reader, new WaveFormat(16000, 16, 1));
        using var output = new MemoryStream();
        var buffer = new byte[32000]; int count;
        while ((count = resampler.Read(buffer, 0, buffer.Length)) > 0) output.Write(buffer, 0, count);
        return output.ToArray();
    }
}
