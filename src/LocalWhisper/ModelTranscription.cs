using System.Net.WebSockets;
using System.Text.Json;

namespace LocalWhisper;

internal sealed record ModelAttempt(string Model, string Error);
internal sealed record ModelTranscriptionResult(string Text, string RequestedModel, string UsedModel, ModelAttempt[] FailedAttempts);

internal sealed class ModelTranscription
{
    internal delegate Task<string> TranscribeModel(string model, byte[] audio, string format,
        IReadOnlyList<string> dictionary, CancellationToken cancellation);

    private readonly TranscribeModel transcribe;
    private readonly Func<string, bool> available;

    public ModelTranscription(TranscribeModel transcribe, Func<string, bool> available)
    {
        this.transcribe = transcribe;
        this.available = available;
    }

    internal static string[] FallbackOrder(string requested) => requested switch
    {
        TranscriptionModels.GrokStreaming => [TranscriptionModels.GrokStreaming, TranscriptionModels.MaiClean, TranscriptionModels.Gpt],
        TranscriptionModels.Gpt => [TranscriptionModels.Gpt, TranscriptionModels.MaiClean, TranscriptionModels.GrokStreaming],
        TranscriptionModels.MaiVerbatim => [TranscriptionModels.MaiVerbatim, TranscriptionModels.Gpt, TranscriptionModels.GrokStreaming],
        _ => [TranscriptionModels.MaiClean, TranscriptionModels.Gpt, TranscriptionModels.GrokStreaming]
    };

    public async Task<ModelTranscriptionResult> TranscribeWithFallbackAsync(byte[] audio, string format, string requested,
        IReadOnlyList<string> dictionary, SessionMetrics metrics, CancellationToken cancellation, bool skipRequested = false)
    {
        if (!TranscriptionModels.IsValid(requested)) throw new InvalidOperationException("Invalid transcription model.");
        metrics.RequestedTranscriptionModel = requested;
        var failures = new List<ModelAttempt>();
        foreach (var model in FallbackOrder(requested).Skip(skipRequested ? 1 : 0).Where(available))
        {
            cancellation.ThrowIfCancellationRequested();
            try
            {
                var text = await transcribe(model, audio, format, dictionary, cancellation).ConfigureAwait(false);
                if (string.IsNullOrWhiteSpace(text)) throw new InvalidDataException("The provider returned no transcript.");
                metrics.TranscriptionModel = model;
                return new(text, requested, model, failures.ToArray());
            }
            catch (Exception ex) when (CanFallback(ex, cancellation))
            {
                var attempt = new ModelAttempt(model, SafeReason(ex));
                failures.Add(attempt);
                metrics.Fallback(model, attempt.Error);
            }
        }
        throw new AggregateException("Every available transcription model failed.", failures.Select(failure => new Exception($"{failure.Model}: {failure.Error}")));
    }

    public async Task<ModelTranscriptionResult> TranscribeExactAsync(byte[] audio, string format, string model,
        IReadOnlyList<string> dictionary, SessionMetrics metrics, CancellationToken cancellation)
    {
        if (!TranscriptionModels.IsValid(model)) throw new InvalidOperationException("Invalid transcription model.");
        if (!available(model)) throw new InvalidOperationException(model == TranscriptionModels.GrokStreaming
            ? "Add an xAI API key in Settings first."
            : "Add an OpenRouter API key in Settings first.");
        metrics.RequestedTranscriptionModel = model;
        var text = await transcribe(model, audio, format, dictionary, cancellation).ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(text)) throw new InvalidDataException("The provider returned no transcript.");
        metrics.TranscriptionModel = model;
        return new(text, model, model, []);
    }

    internal static bool CanFallback(Exception error, CancellationToken cancellation)
    {
        if (cancellation.IsCancellationRequested) return false;
        return error switch
        {
            HttpRequestException => true,
            InvalidDataException or JsonException or WebSocketException or TimeoutException or OperationCanceledException => true,
            _ => false
        };
    }

    private static string SafeReason(Exception error)
    {
        var message = string.Join(" ", error.Message.Split(['\r', '\n', '\t'], StringSplitOptions.RemoveEmptyEntries));
        return message.Length > 180 ? message[..180] + "…" : message;
    }
}
