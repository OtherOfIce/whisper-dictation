using System.Net;
using System.Text.Json;

namespace LocalWhisper;

internal static class RecoveryLatencyChecks
{
    internal static async Task RunAsync(Action<bool, string> check)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var handler = new SlowMaiHandler();
        using var http = new HttpClient(handler);
        var pipeline = new TranscriptionPipeline(http, new("test-only", "", ""));
        var metrics = new SessionMetrics();
        // Live streaming has already failed. Exercise the full saved-audio recovery route.
        var recovered = await pipeline.Recorded(metrics, [], doubleTranscription: true).TranscribeWithFallbackAsync(
            new byte[6000], "mp3", TranscriptionModels.MaiStreaming, [], metrics, deadline.Token, skipRequested: true);
        check(recovered.Text == "GPT recovered" && recovered.UsedModel == TranscriptionModels.Gpt
            && metrics.TranscriptionModel == TranscriptionModels.Gpt && handler.GptCalls == 1,
            "Streaming recovery escapes stalled MAI through GPT within five seconds and records the winning model");
        handler.ReleaseMai.TrySetResult();
        await metrics.WaitForBackgroundAsync();
        foreach (var failedMai in new[] { 1, 2 })
        {
            var partialHandler = new SlowMaiHandler(failedMai);
            using var partialHttp = new HttpClient(partialHandler);
            var partialMetrics = new SessionMetrics();
            check(await new Transcriber(partialHttp) { ParallelFallbackDelay = _ => TimeSpan.FromMilliseconds(20) }
                .TranscribeAsync([0], "test-only", deadline.Token, partialMetrics, doubleTranscription: true) == "GPT recovered"
                && partialHandler.GptCalls == 1,
                $"GPT recovery survives {failedMai} failed MAI requests");
            partialHandler.ReleaseMai.TrySetResult();
            await partialMetrics.WaitForBackgroundAsync();
        }
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(30));
        var blocked = new SlowMaiHandler();
        using var blockedHttp = new HttpClient(blocked);
        var blockedMetrics = new SessionMetrics();
        try
        {
            await new TranscriptionPipeline(blockedHttp, new("test-only", "", "")).Recorded(blockedMetrics, [], true)
                .TranscribeWithFallbackAsync([0], "mp3", TranscriptionModels.MaiStreaming, [], blockedMetrics,
                    cancellation.Token, skipRequested: true);
            throw new Exception("Expected the shared recovery deadline to cancel transcription");
        }
        catch (OperationCanceledException)
        {
            check(blocked.GptCalls == 0, "An expired shared deadline stops recovery without starting more providers");
        }
        await blockedMetrics.WaitForBackgroundAsync();
    }

    private sealed class SlowMaiHandler(int failedMai = 0) : HttpMessageHandler
    {
        internal int GptCalls;
        private int maiCalls;
        internal TaskCompletionSource ReleaseMai = new(TaskCreationOptions.RunContinuationsAsynchronously);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            if (body.RootElement.GetProperty("model").GetString() == Transcriber.MaiModel)
            {
                if (Interlocked.Increment(ref maiCalls) <= failedMai)
                    return new(HttpStatusCode.ServiceUnavailable);
                await ReleaseMai.Task.WaitAsync(token);
            }
            else Interlocked.Increment(ref GptCalls);
            return new(HttpStatusCode.OK) { Content = new StringContent("{\"text\":\"GPT recovered\"}") };
        }
    }
}
