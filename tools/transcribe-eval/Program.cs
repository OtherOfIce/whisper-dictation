using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using LocalWhisper;
using NAudio.Wave;

var source = Argument(args, "--source") ?? @"C:\Users\Liam\Downloads\WhiperFlow";
var output = Argument(args, "--output") ?? "artifacts/transcribe-eval-gpt-transcribe.json";
if (!Directory.Exists(source))
{
    Console.Error.WriteLine($"Source folder does not exist: {source}");
    return 2;
}

var pairs = Directory.GetFiles(source, "*.wav")
    .Select(wav => new Sample(Path.GetFileNameWithoutExtension(wav), wav, Path.ChangeExtension(wav, ".txt")))
    .Where(sample => File.Exists(sample.ReferencePath))
    .OrderBy(sample => int.TryParse(sample.Id, out var number) ? number : int.MaxValue)
    .ThenBy(sample => sample.Id, StringComparer.OrdinalIgnoreCase)
    .ToArray();
if (pairs.Length == 0)
{
    Console.Error.WriteLine("No WAV/TXT pairs found.");
    return 2;
}

var key = Settings.LoadKey();
if (string.IsNullOrWhiteSpace(key))
{
    Console.Error.WriteLine("No saved OpenRouter key was found. Add one in Local Whisper Settings or set OPENROUTER_API_KEY.");
    return 2;
}

using var capture = new UsageCaptureHandler(new HttpClientHandler());
using var http = new HttpClient(capture) { Timeout = Timeout.InfiniteTimeSpan };
var transcriber = new Transcriber(http);
var results = new List<SampleResult>();

Console.WriteLine($"GPT Transcribe eval: {pairs.Length} WAV/TXT pairs");
Console.WriteLine("Each file is sent once. The locally saved key is never printed or written to the report.");

foreach (var pair in pairs)
{
    try
    {
        var reference = (await File.ReadAllTextAsync(pair.ReferencePath)).Trim();
        var wav = await File.ReadAllBytesAsync(pair.WavPath);
        double audioSeconds;
        using (var reader = new WaveFileReader(pair.WavPath)) audioSeconds = reader.TotalTime.TotalSeconds;

        var encodeWatch = Stopwatch.StartNew();
        var encoded = AudioEncoding.Compress(wav);
        encodeWatch.Stop();

        capture.Reset();
        var requestWatch = Stopwatch.StartNew();
        var transcript = await transcriber.TranscribeAsync(encoded.Bytes, key, default, format: encoded.Format);
        requestWatch.Stop();

        var distance = WordDistance(reference, transcript);
        var estimate = (decimal)audioSeconds / 60m * 0.0045m;
        var result = new SampleResult(pair.Id, audioSeconds, wav.LongLength, encoded.Bytes.LongLength,
            encodeWatch.Elapsed.TotalMilliseconds, requestWatch.Elapsed.TotalMilliseconds,
            reference, transcript, distance.ReferenceWords, distance.Substitutions,
            distance.Deletions, distance.Insertions, distance.ErrorRate,
            capture.UsageSeconds, capture.InputTokens, capture.OutputTokens,
            capture.TotalTokens, capture.Cost, estimate, null);
        results.Add(result);
        Console.WriteLine($"{pair.Id,2}: audio={audioSeconds,5:F1}s mp3={encoded.Bytes.Length / 1024.0,6:F1}KiB encode={encodeWatch.Elapsed.TotalMilliseconds,5:F0}ms request={requestWatch.Elapsed.TotalMilliseconds,5:F0}ms WER={distance.ErrorRate,6:P1} S/D/I={distance.Substitutions}/{distance.Deletions}/{distance.Insertions} cost={Money(capture.Cost)}");
    }
    catch (Exception error)
    {
        results.Add(new SampleResult(pair.Id, 0, 0, 0, 0, 0, "", "", 0, 0, 0, 0, 0,
            null, null, null, null, null, 0, $"{error.GetType().Name}: {error.Message}"));
        Console.WriteLine($"{pair.Id,2}: ERROR {error.Message}");
    }
}

var successful = results.Where(result => result.Error is null).ToArray();
var reportedCosts = successful.Where(result => result.ReportedCost.HasValue).Select(result => result.ReportedCost!.Value).ToArray();
var aggregate = new Aggregate(
    pairs.Length,
    successful.Length,
    successful.Sum(result => result.AudioSeconds),
    Median(successful.Select(result => result.EncodeMs)),
    Median(successful.Select(result => result.RequestMs)),
    successful.Length == 0 ? 0 : successful.Average(result => result.RequestMs),
    successful.Sum(result => result.Substitutions + result.Deletions + result.Insertions),
    successful.Sum(result => result.ReferenceWords),
    MicroWer(successful),
    successful.Length == 0 ? 0 : successful.Average(result => result.WordErrorRate),
    reportedCosts.Length == 0 ? null : reportedCosts.Sum(),
    reportedCosts.Length,
    successful.Sum(result => result.EstimatedCost));

Console.WriteLine($"Summary: success={aggregate.Successful}/{aggregate.Samples} audio={aggregate.AudioSeconds:F1}s median-request={aggregate.MedianRequestMs:F0}ms mean-request={aggregate.MeanRequestMs:F0}ms micro-WER={aggregate.MicroWordErrorRate:P1} macro-WER={aggregate.MacroWordErrorRate:P1} reported-cost={Money(aggregate.ReportedCost)} duration-estimate={Money(aggregate.EstimatedCost)}");

var report = new Report(DateTimeOffset.Now, source, Transcriber.Model,
    "Wispr Flow references may contain automatic editing and are not verbatim ground truth.", aggregate, results);
var fullOutput = Path.GetFullPath(output);
Directory.CreateDirectory(Path.GetDirectoryName(fullOutput)!);
await File.WriteAllTextAsync(fullOutput, JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
Console.WriteLine($"Private report: {fullOutput}");
return successful.Length == pairs.Length ? 0 : 1;

static Distance WordDistance(string reference, string hypothesis)
{
    var a = Words(reference);
    var b = Words(hypothesis);
    var cells = new Cell[a.Length + 1, b.Length + 1];
    cells[0, 0] = new Cell(0, 0, 0, 0);
    for (var i = 1; i <= a.Length; i++) cells[i, 0] = new Cell(i, 0, i, 0);
    for (var j = 1; j <= b.Length; j++) cells[0, j] = new Cell(j, 0, 0, j);
    for (var i = 1; i <= a.Length; i++)
    for (var j = 1; j <= b.Length; j++)
    {
        var candidates = new[]
        {
            a[i - 1] == b[j - 1]
                ? cells[i - 1, j - 1]
                : cells[i - 1, j - 1] with { Cost = cells[i - 1, j - 1].Cost + 1, Substitutions = cells[i - 1, j - 1].Substitutions + 1 },
            cells[i - 1, j] with { Cost = cells[i - 1, j].Cost + 1, Deletions = cells[i - 1, j].Deletions + 1 },
            cells[i, j - 1] with { Cost = cells[i, j - 1].Cost + 1, Insertions = cells[i, j - 1].Insertions + 1 }
        };
        cells[i, j] = candidates.OrderBy(cell => cell.Cost).ThenBy(cell => cell.Substitutions).First();
    }
    var final = cells[a.Length, b.Length];
    return new Distance(a.Length, final.Substitutions, final.Deletions, final.Insertions,
        a.Length == 0 ? (b.Length == 0 ? 0 : 1) : (double)final.Cost / a.Length);
}

static string[] Words(string value) => Regex.Matches(value.ToLowerInvariant().Normalize(NormalizationForm.FormKC), @"[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?")
    .Select(match => match.Value.Replace('’', '\''))
    .ToArray();

static double MicroWer(IEnumerable<SampleResult> results)
{
    var values = results.ToArray();
    var words = values.Sum(value => value.ReferenceWords);
    return words == 0 ? 0 : (double)values.Sum(value => value.Substitutions + value.Deletions + value.Insertions) / words;
}

static double Median(IEnumerable<double> source)
{
    var values = source.Order().ToArray();
    return values.Length switch
    {
        0 => 0,
        _ when values.Length % 2 == 1 => values[values.Length / 2],
        _ => (values[values.Length / 2 - 1] + values[values.Length / 2]) / 2
    };
}

static string? Argument(string[] values, string name)
{
    var index = Array.IndexOf(values, name);
    return index >= 0 && index + 1 < values.Length ? values[index + 1] : null;
}

static string Money(decimal? value) => value.HasValue ? $"${value.Value:F6}" : "n/a";

internal sealed class UsageCaptureHandler(HttpMessageHandler inner) : DelegatingHandler(inner)
{
    public double? UsageSeconds { get; private set; }
    public int? InputTokens { get; private set; }
    public int? OutputTokens { get; private set; }
    public int? TotalTokens { get; private set; }
    public decimal? Cost { get; private set; }

    public void Reset() => (UsageSeconds, InputTokens, OutputTokens, TotalTokens, Cost) = (null, null, null, null, null);

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var response = await base.SendAsync(request, cancellationToken);
        if (response.Content is null) return response;
        var bytes = await response.Content.ReadAsByteArrayAsync(cancellationToken);
        var mediaType = response.Content.Headers.ContentType?.MediaType;
        response.Content.Dispose();
        response.Content = new ByteArrayContent(bytes);
        if (mediaType is not null) response.Content.Headers.ContentType = new(mediaType);
        try
        {
            using var json = JsonDocument.Parse(bytes);
            if (json.RootElement.TryGetProperty("usage", out var usage))
            {
                UsageSeconds = Number(usage, "seconds");
                InputTokens = Integer(usage, "input_tokens");
                OutputTokens = Integer(usage, "output_tokens");
                TotalTokens = Integer(usage, "total_tokens");
                Cost = Decimal(usage, "cost");
            }
        }
        catch (JsonException) { }
        return response;
    }

    private static double? Number(JsonElement value, string name) => value.TryGetProperty(name, out var property) && property.TryGetDouble(out var number) ? number : null;
    private static int? Integer(JsonElement value, string name) => value.TryGetProperty(name, out var property) && property.TryGetInt32(out var number) ? number : null;
    private static decimal? Decimal(JsonElement value, string name) => value.TryGetProperty(name, out var property) && property.TryGetDecimal(out var number) ? number : null;
}

internal sealed record Sample(string Id, string WavPath, string ReferencePath);
internal sealed record Cell(int Cost, int Substitutions, int Deletions, int Insertions);
internal sealed record Distance(int ReferenceWords, int Substitutions, int Deletions, int Insertions, double ErrorRate);
internal sealed record SampleResult(string Id, double AudioSeconds, long WavBytes, long Mp3Bytes,
    double EncodeMs, double RequestMs, string Reference, string Transcript, int ReferenceWords,
    int Substitutions, int Deletions, int Insertions, double WordErrorRate, double? UsageSeconds,
    int? InputTokens, int? OutputTokens, int? TotalTokens, decimal? ReportedCost,
    decimal EstimatedCost, string? Error);
internal sealed record Aggregate(int Samples, int Successful, double AudioSeconds, double MedianEncodeMs,
    double MedianRequestMs, double MeanRequestMs, int WordErrors, int ReferenceWords,
    double MicroWordErrorRate, double MacroWordErrorRate, decimal? ReportedCost, int ReportedCostSamples,
    decimal EstimatedCost);
internal sealed record Report(DateTimeOffset RunAt, string SourceFolder, string Model, string ReferenceWarning,
    Aggregate Aggregate, List<SampleResult> Results);
