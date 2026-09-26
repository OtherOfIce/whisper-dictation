using System.Diagnostics;
using System.Text.Json;
using NAudio.Wave;

namespace LocalWhisper;

internal static class MaiDualBenchmark
{
    // One seeded random pick from each duration band in the saved corpus.
    private static readonly string[] Samples =
    [
        "20260906T113100Z-2cb950e0", // 3.1 seconds
        "20260906T111927Z-f7910640", // 7.2 seconds
        "20260904T143150Z-dd2efa00", // 19.0 seconds
        "20260912T172251Z-f114f6d2", // 28.1 seconds
        "20260906T114443Z-db647406"  // 33.0 seconds
    ];

    public static async Task RunAsync(string[] args)
    {
        var pairIndex = Array.IndexOf(args, "--pairs");
        var pairs = pairIndex >= 0 && pairIndex + 1 < args.Length && int.TryParse(args[pairIndex + 1], out var requested)
            ? requested : 4;
        if (pairs is < 1 or > 50) throw new ArgumentOutOfRangeException(nameof(args), "--pairs must be from 1 to 50.");
        var key = Settings.LoadKey();
        if (string.IsNullOrWhiteSpace(key)) throw new InvalidOperationException("No saved OpenRouter key.");
        using var http = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
        var results = new List<object>();
        var output = Path.GetFullPath("artifacts/mai-dual-benchmark.json");
        foreach (var sample in Samples)
        {
            var path = Path.GetFullPath($"artifacts/wispr-corpus-before-reviewed-suite/normal/{sample}.wav");
            using var reader = new WaveFileReader(path);
            var seconds = reader.TotalTime.TotalSeconds;
            var encoded = AudioEncoding.Compress(await File.ReadAllBytesAsync(path));
            for (var repeat = 1; repeat <= pairs; repeat++)
            {
                using var cancellation = new CancellationTokenSource(TimeSpan.FromMinutes(3));
                var start = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                var first = CallAsync();
                var second = CallAsync();
                start.SetResult();
                var attempts = await Task.WhenAll(first, second);
                var winner = attempts[0].ElapsedMs <= attempts[1].ElapsedMs ? 1 : 2;
                var result = new
                {
                    sample, audioSeconds = seconds, repeat,
                    firstMs = attempts[0].ElapsedMs, secondMs = attempts[1].ElapsedMs,
                    winner, savedVsFirstMs = attempts[0].ElapsedMs - Math.Min(attempts[0].ElapsedMs, attempts[1].ElapsedMs),
                    sameTranscript = attempts[0].Text is not null && attempts[0].Text == attempts[1].Text,
                    firstError = attempts[0].Error, secondError = attempts[1].Error,
                    firstCost = attempts[0].Cost, secondCost = attempts[1].Cost,
                    firstRetries = attempts[0].Retries, secondRetries = attempts[1].Retries
                };
                results.Add(result);
                await File.WriteAllTextAsync(output, JsonSerializer.Serialize(results, new JsonSerializerOptions { WriteIndented = true }));
                Console.WriteLine($"{seconds,4:F1}s pair {repeat}: {result.firstMs,7:F0} / {result.secondMs,7:F0} ms, "
                    + $"winner {winner}, saved {result.savedVsFirstMs:F0} ms, same text {result.sameTranscript}, "
                    + $"cost ${result.firstCost + result.secondCost:F6}"
                    + (result.firstError is null && result.secondError is null ? "" : $", errors {result.firstError} / {result.secondError}"));

                async Task<(double ElapsedMs, string? Text, string? Error, decimal Cost, int Retries)> CallAsync()
                {
                    var metrics = new SessionMetrics();
                    await start.Task;
                    var watch = Stopwatch.StartNew();
                    string? text = null, error = null;
                    try
                    {
                        text = await new Transcriber(http) { HedgeDelay = _ => TimeSpan.Zero }
                            .TranscribeAsync(encoded.Bytes, key, cancellation.Token, metrics,
                                format: encoded.Format, transcriptionModel: TranscriptionModels.MaiClean);
                    }
                    catch (Exception ex) { error = ex.GetType().Name + ": " + ex.Message; }
                    var snapshot = metrics.Snapshot();
                    return (watch.Elapsed.TotalMilliseconds, text, error,
                        snapshot.Costs.Sum(row => row.Amount),
                        snapshot.Rows.Count(row => row.Name.StartsWith("Retry wait", StringComparison.Ordinal)));
                }
            }
        }
        Console.WriteLine($"Report: {output}");
    }
}
