using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using NAudio.Wave;

namespace LocalWhisper;

internal static class MaiPauseBenchmark
{
    private static readonly string[] Samples =
    [
        "20260906T110235Z-4f1a2c1f",
        "20260912T172251Z-f114f6d2",
        "20260906T111439Z-ce1101c6"
    ];

    public static async Task RunAsync()
    {
        var key = Settings.LoadKey();
        if (string.IsNullOrWhiteSpace(key)) throw new InvalidOperationException("No saved OpenRouter key.");
        using var http = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
        var results = new List<object>();
        foreach (var sample in Samples)
        {
            var path = Path.GetFullPath($"artifacts/wispr-corpus-before-reviewed-suite/normal/{sample}.wav");
            var reference = await File.ReadAllTextAsync(Path.ChangeExtension(path, ".txt"));
            foreach (var live in new[] { false, true, true, false })
            {
                using var reader = new WaveFileReader(path);
                if (reader.WaveFormat.SampleRate != 16000 || reader.WaveFormat.Channels != 1
                    || reader.WaveFormat.BitsPerSample != 16)
                    throw new InvalidDataException("Benchmark requires 16 kHz mono 16-bit WAV.");
                var pcm = new byte[reader.Length];
                reader.ReadExactly(pcm);
                var metrics = new SessionMetrics();
                using var cancellation = new CancellationTokenSource(TimeSpan.FromMinutes(3));
                var session = new TranscriptionSession(http, key, metrics, cancellation.Token,
                    transcriptionModel: TranscriptionModels.MaiClean);
                var watch = Stopwatch.StartNew();
                if (live)
                {
                    var pauses = new PauseChunks();
                    const int frameBytes = 1280;
                    for (var offset = 0; offset < pcm.Length; offset += frameBytes)
                    {
                        var count = Math.Min(frameBytes, pcm.Length - offset);
                        var frame = new byte[count];
                        Buffer.BlockCopy(pcm, offset, frame, 0, count);
                        float peak = 0;
                        for (var i = 0; i + 1 < count; i += 2)
                            peak = Math.Max(peak, Math.Abs(BitConverter.ToInt16(frame, i) / 32768f));
                        var chunk = pauses.Add(frame, count, peak);
                        if (chunk is not null) session.EnqueuePcm(chunk);
                        var nextFrameTime = (offset + count) / 32.0;
                        var wait = nextFrameTime - watch.Elapsed.TotalMilliseconds;
                        if (wait > 1) await Task.Delay(TimeSpan.FromMilliseconds(wait), cancellation.Token);
                    }
                    var tail = pauses.Drain();
                    if (tail.Length > 0) session.EnqueuePcm(tail);
                }
                else session.EnqueuePcm(pcm);
                var stopMs = watch.Elapsed.TotalMilliseconds;
                string? transcript = null, error = null;
                try { transcript = await session.FinishAsync(); }
                catch (Exception ex) { error = ex.GetType().Name + ": " + ex.Message; }
                var snapshot = metrics.Snapshot();
                var distance = transcript is null ? (int?)null : WordDistance(reference, transcript);
                var cost = snapshot.Costs.Sum(row => row.Amount);
                var result = new
                {
                    sample, live, audioSeconds = pcm.Length / 32000.0, chunks = session.Count,
                    stopToResultMs = watch.Elapsed.TotalMilliseconds - stopMs,
                    recordingClockMs = stopMs, wordErrors = distance,
                    referenceWords = Words(reference).Length, cost, hedges = snapshot.Hedges.Length,
                    failedChunks = session.Failed, error
                };
                results.Add(result);
                Console.WriteLine($"{sample} {(live ? "pause" : "single"),6}: {result.stopToResultMs:F0} ms after Stop, "
                    + $"{result.chunks} chunks, {distance?.ToString() ?? "error"}/{result.referenceWords} word errors, "
                    + $"${cost:F6}, {result.hedges} hedges{(error is null ? "" : ", " + error)}");
            }
        }
        var output = Path.GetFullPath("artifacts/mai-pause-benchmark.json");
        await File.WriteAllTextAsync(output, JsonSerializer.Serialize(results, new JsonSerializerOptions { WriteIndented = true }));
        Console.WriteLine($"Report: {output}");
    }

    private static string[] Words(string value) => Regex.Matches(value.ToLowerInvariant(), @"[\p{L}\p{N}]+(?:'[\p{L}]+)?")
        .Select(match => match.Value).ToArray();

    private static int WordDistance(string expected, string actual)
    {
        var a = Words(expected);
        var b = Words(actual);
        var previous = Enumerable.Range(0, b.Length + 1).ToArray();
        for (var i = 1; i <= a.Length; i++)
        {
            var current = new int[b.Length + 1];
            current[0] = i;
            for (var j = 1; j <= b.Length; j++)
                current[j] = Math.Min(Math.Min(previous[j] + 1, current[j - 1] + 1),
                    previous[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
            previous = current;
        }
        return previous[b.Length];
    }
}
