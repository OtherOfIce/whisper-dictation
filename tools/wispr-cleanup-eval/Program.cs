using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using LocalWhisper;

var inputPath = Argument(args, "--input");
var sourcePath = Argument(args, "--source");
var contextSourcePath = Argument(args, "--context-source");
var sampleId = Argument(args, "--sample");
var model = Argument(args, "--model") ?? CleanupService.Model;
var provider = Argument(args, "--provider");
var reasoningEffort = Argument(args, "--reasoning-effort") ?? (model == CleanupService.Model ? "none" : "low");
var minimumCompletionTokens = IntArgument(args, "--minimum-completion-tokens") ?? 0;
var promptSetPath = Argument(args, "--prompt-set");
var promptId = Argument(args, "--prompt-id");
if ((promptSetPath is null) != (promptId is null))
{
    Console.Error.WriteLine("Pass --prompt-set and --prompt-id together.");
    return 2;
}
var selectedPrompt = promptSetPath is null ? CleanupService.Prompt : LoadPrompt(promptSetPath, promptId!);
var outputPath = Argument(args, "--output") ?? "artifacts/luna-wispr-eval.json";
var tierOption = (Argument(args, "--tier") ?? "both").ToLowerInvariant();
if (tierOption is not ("standard" or "fast" or "both"))
{
    Console.Error.WriteLine("--tier must be standard, fast, or both.");
    return 2;
}
if (inputPath is not null && sourcePath is not null)
{
    Console.Error.WriteLine("Pass either --input or --source, not both.");
    return 2;
}
inputPath ??= sourcePath is null ? "artifacts/transcribe-eval-gpt-transcribe.json" : null;

TranscribeReport? source;
string warning;
if (sourcePath is not null)
{
    if (!Directory.Exists(sourcePath))
    {
        Console.Error.WriteLine($"Review corpus does not exist: {Path.GetFullPath(sourcePath)}");
        return 2;
    }
    source = LoadReviewCorpus(sourcePath);
    warning = "References are audio-reviewed canonicals. Luna input is saved Wispr asrText; this is a cleanup-only benchmark.";
}
else
{
    if (!File.Exists(inputPath))
    {
        Console.Error.WriteLine($"Input report does not exist: {Path.GetFullPath(inputPath!)}");
        return 2;
    }
    source = JsonSerializer.Deserialize<TranscribeReport>(await File.ReadAllTextAsync(inputPath!),
        new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
    if (source is not null && contextSourcePath is not null) source = AttachContexts(source, contextSourcePath);
    warning = "References come from the input transcription report. Sequential pipeline figures combine measurements from separate benchmark runs.";
}
if (source?.Results is null || source.Results.Count == 0)
{
    Console.Error.WriteLine("Input report has no transcription results.");
    return 2;
}
if (sampleId is not null)
{
    source = new TranscribeReport(source.Results.Where(result => result.Id.Equals(sampleId, StringComparison.OrdinalIgnoreCase)).ToList());
    if (source.Results.Count == 0)
    {
        Console.Error.WriteLine($"Sample was not found in the input report: {sampleId}");
        return 2;
    }
}

var key = Settings.LoadKey();
if (string.IsNullOrWhiteSpace(key))
{
    Console.Error.WriteLine("No saved OpenRouter key was found. Add one in Local Whisper Settings or set OPENROUTER_API_KEY.");
    return 2;
}

using var capture = new ResponseCaptureHandler(new HttpClientHandler());
using var http = new HttpClient(capture) { Timeout = Timeout.InfiniteTimeSpan };
var cleanup = new CleanupService(http);
var profile = new CleanupRequestProfile(model, reasoningEffort, provider, SendServiceTier: model == CleanupService.Model,
    MinimumCompletionTokens: minimumCompletionTokens, Prompt: selectedPrompt);
var fullOutput = Path.GetFullPath(outputPath);
Directory.CreateDirectory(Path.GetDirectoryName(fullOutput)!);
var previous = File.Exists(fullOutput)
    ? JsonSerializer.Deserialize<CleanupReport>(await File.ReadAllTextAsync(fullOutput),
        new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
    : null;
var runs = previous?.Model == model && previous.Provider == provider && previous.ReasoningEffort == reasoningEffort && previous.Prompt == selectedPrompt
    ? previous.Runs
    : new List<CleanupRun>();
var tiers = tierOption switch
{
    "standard" => new[] { CleanupServiceTier.Standard },
    "fast" => new[] { CleanupServiceTier.Fast },
    _ => new[] { CleanupServiceTier.Standard, CleanupServiceTier.Fast }
};
var tierNames = tiers.Select(tier => tier.ToString()).ToArray();

Console.WriteLine($"Wispr cleanup eval: {source.Results.Count} saved transcripts, tiers={string.Join(',', tierNames)}, model={model}, provider={provider ?? "automatic"}, reasoning={reasoningEffort}, prompt={promptId ?? "production"}");
Console.WriteLine("Each selected tier is called once per transcript. The saved key is never printed or written.");

for (var index = 0; index < source.Results.Count; index++)
{
    var sample = source.Results[index];
    var rawDistance = WordDistance(sample.Reference, sample.Transcript);
    var pairedOrder = index % 2 == 0
        ? new[] { CleanupServiceTier.Standard, CleanupServiceTier.Fast }
        : new[] { CleanupServiceTier.Fast, CleanupServiceTier.Standard };
    var order = pairedOrder.Where(tiers.Contains).ToArray();

    foreach (var tier in order)
    {
        if (runs.Any(run => run.Id == sample.Id && run.Tier == tier.ToString()))
        {
            Console.WriteLine($"{sample.Id,2} {tier,-8} already saved; skipping");
            continue;
        }
        capture.Reset();
        var watch = Stopwatch.StartNew();
        try
        {
            var result = await cleanup.CleanupAsync(sample.Transcript, sample.Context, key, tier, profile, default);
            watch.Stop();
            var cleanedDistance = WordDistance(sample.Reference, result.Text);
            var rawTier = capture.ServiceTier;
            var requestedTier = profile.SendServiceTier ? tier == CleanupServiceTier.Fast ? "priority" : "default" : "unspecified";
            runs.Add(new CleanupRun(sample.Id, tier.ToString(), requestedTier, rawTier,
                !profile.SendServiceTier || rawTier == requestedTier, watch.Elapsed.TotalMilliseconds, sample.AudioSeconds,
                sample.EncodeMs, sample.RequestMs, sample.ReportedCost, sample.Reference,
                sample.Transcript, result.Text, rawDistance, cleanedDistance, result.InputTokens,
                result.OutputTokens, result.ReasoningTokens, capture.Cost ?? result.Cost, null));
            await SaveReportAsync(fullOutput, warning, model, provider, reasoningEffort, selectedPrompt, tierNames, runs);
            Console.WriteLine($"{sample.Id,2} {tier,-8} {watch.Elapsed.TotalMilliseconds,5:F0}ms tier={(rawTier ?? "absent"),-8} raw={rawDistance.ErrorRate,6:P1} clean={cleanedDistance.ErrorRate,6:P1} cost={Money(capture.Cost ?? result.Cost)}");
        }
        catch (Exception error)
        {
            watch.Stop();
            runs.Add(new CleanupRun(sample.Id, tier.ToString(), profile.SendServiceTier ? tier == CleanupServiceTier.Fast ? "priority" : "default" : "unspecified",
                capture.ServiceTier, false, watch.Elapsed.TotalMilliseconds, sample.AudioSeconds,
                sample.EncodeMs, sample.RequestMs, sample.ReportedCost, sample.Reference,
                sample.Transcript, null, rawDistance, null, 0, 0, 0, capture.Cost,
                $"{error.GetType().Name}: {error.Message}"));
            await SaveReportAsync(fullOutput, warning, model, provider, reasoningEffort, selectedPrompt, tierNames, runs);
            Console.WriteLine($"{sample.Id,2} {tier,-8} ERROR {error.Message}");
        }
    }
}

var summaries = tierNames.Select(tier => Summarize(tier, runs)).ToArray();
foreach (var summary in summaries)
{
    Console.WriteLine($"{summary.Tier,-8} success={summary.Successful}/{summary.Samples} median={summary.MedianCleanupMs:F0}ms mean={summary.MeanCleanupMs:F0}ms raw-WER={summary.RawMicroWer:P1} clean-WER={summary.CleanMicroWer:P1} cost={Money(summary.CleanupCost)} tier-confirmed={summary.TierConfirmed}/{summary.Successful} sequential-pipeline={summary.MedianSequentialPipelineMs:F0}ms combined-cost={Money(summary.CombinedCost)}");
}

await SaveReportAsync(fullOutput, warning, model, provider, reasoningEffort, selectedPrompt, tierNames, runs);
Console.WriteLine($"Private report: {fullOutput}");
return runs.Any(run => run.Error is not null) ? 1 : 0;

static async Task SaveReportAsync(string path, string warning, string model, string? provider, string reasoningEffort,
    string prompt, string[] tiers, List<CleanupRun> runs)
{
    var report = new CleanupReport(DateTimeOffset.Now, model,
        warning, prompt, tiers.Select(tier => Summarize(tier, runs)).ToArray(), runs, provider, reasoningEffort);
    await File.WriteAllTextAsync(path, JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
}

static TranscribeReport LoadReviewCorpus(string sourcePath)
{
    var manifestPath = Path.Combine(sourcePath, "manifest.json");
    var durations = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
    if (File.Exists(manifestPath))
    {
        using var manifest = JsonDocument.Parse(File.ReadAllBytes(manifestPath));
        if (manifest.RootElement.TryGetProperty("samples", out var samples) && samples.ValueKind == JsonValueKind.Array)
            foreach (var sample in samples.EnumerateArray())
            {
                if (!sample.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.String) continue;
                var duration = sample.TryGetProperty("durationSeconds", out var seconds) && seconds.TryGetDouble(out var number) ? number : 0;
                durations[id.GetString()!] = duration;
            }
    }

    var results = new List<TranscribeSample>();
    foreach (var reviewedPath in Directory.GetFiles(sourcePath, "*.reviewed.txt").Order(StringComparer.OrdinalIgnoreCase))
    {
        var id = Path.GetFileName(reviewedPath)[..^".reviewed.txt".Length];
        var transcriptPath = Path.Combine(sourcePath, $"{id}.transcripts.json");
        if (!File.Exists(transcriptPath)) continue;
        using var transcripts = JsonDocument.Parse(File.ReadAllBytes(transcriptPath));
        if (!transcripts.RootElement.TryGetProperty("asrText", out var asr) || asr.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(asr.GetString())) continue;
        var reference = File.ReadAllText(reviewedPath).Trim();
        if (!string.IsNullOrWhiteSpace(reference))
            results.Add(new TranscribeSample(id, durations.GetValueOrDefault(id), 0, 0, null, reference, asr.GetString()!.Trim(), ReadContext(sourcePath, id)));
    }
    return new TranscribeReport(results);
}

static TranscribeReport AttachContexts(TranscribeReport source, string contextSourcePath)
{
    if (!Directory.Exists(contextSourcePath)) throw new DirectoryNotFoundException($"Context corpus does not exist: {Path.GetFullPath(contextSourcePath)}");
    return new TranscribeReport(source.Results.Select(sample => sample with { Context = ReadContext(contextSourcePath, sample.Id) }).ToList());
}

static InsertionContext? ReadContext(string sourcePath, string id)
{
    var path = Path.Combine(sourcePath, $"{id}.candidate.json");
    if (!File.Exists(path)) return null;
    using var json = JsonDocument.Parse(File.ReadAllBytes(path));
    if (!json.RootElement.TryGetProperty("context", out var context) || context.ValueKind != JsonValueKind.Object) return null;
    static string Text(JsonElement value, string name) => value.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.String ? property.GetString() ?? "" : "";
    var result = new InsertionContext(Text(context, "beforeText"), Text(context, "selectedText"), Text(context, "afterText"));
    return result.HasText ? result : null;
}

static TierSummary Summarize(string tier, List<CleanupRun> allRuns)
{
    var runs = allRuns.Where(run => run.Tier == tier).ToArray();
    var good = runs.Where(run => run.Error is null && run.CleanedDistance is not null).ToArray();
    var cleanupCosts = good.Where(run => run.CleanupCost.HasValue).Select(run => run.CleanupCost!.Value).ToArray();
    var transcribeCosts = good.Where(run => run.TranscribeCost.HasValue).Select(run => run.TranscribeCost!.Value).ToArray();
    decimal? cleanupCost = cleanupCosts.Length == good.Length ? cleanupCosts.Sum() : null;
    decimal? combinedCost = cleanupCost.HasValue && transcribeCosts.Length == good.Length
        ? cleanupCost.Value + transcribeCosts.Sum()
        : null;
    return new TierSummary(tier, runs.Length, good.Length, good.Count(run => run.TierConfirmed),
        Median(good.Select(run => run.CleanupMs)), good.Length == 0 ? 0 : good.Average(run => run.CleanupMs),
        MicroWer(good.Select(run => run.RawDistance)), MicroWer(good.Select(run => run.CleanedDistance!)),
        cleanupCost, combinedCost,
        Median(good.Select(run => run.TranscribeRequestMs + run.CleanupMs)),
        Median(good.Select(run => run.EncodeMs + run.TranscribeRequestMs + run.CleanupMs)));
}

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

static double MicroWer(IEnumerable<Distance> distances)
{
    var values = distances.ToArray();
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

static int? IntArgument(string[] values, string name) =>
    int.TryParse(Argument(values, name), out var result) && result >= 0 ? result : null;

static string LoadPrompt(string path, string id)
{
    using var json = JsonDocument.Parse(File.ReadAllBytes(path));
    foreach (var variant in json.RootElement.GetProperty("variants").EnumerateArray())
        if (variant.GetProperty("id").GetString() == id)
            return variant.GetProperty("prompt").GetString() ?? throw new InvalidDataException($"Prompt '{id}' is empty.");
    throw new InvalidDataException($"Prompt '{id}' was not found in {Path.GetFullPath(path)}.");
}

static string Money(decimal? value) => value.HasValue ? $"${value.Value:F6}" : "n/a";

internal sealed class ResponseCaptureHandler(HttpMessageHandler inner) : DelegatingHandler(inner)
{
    public string? ServiceTier { get; private set; }
    public decimal? Cost { get; private set; }
    public void Reset() => (ServiceTier, Cost) = (null, null);

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
            var root = json.RootElement;
            if (root.TryGetProperty("service_tier", out var tier) && tier.ValueKind == JsonValueKind.String)
                ServiceTier = tier.GetString();
            if (root.TryGetProperty("usage", out var usage) && usage.TryGetProperty("cost", out var cost) && cost.TryGetDecimal(out var number))
                Cost = number;
        }
        catch (JsonException) { }
        return response;
    }
}

internal sealed record Cell(int Cost, int Substitutions, int Deletions, int Insertions);
internal sealed record Distance(int ReferenceWords, int Substitutions, int Deletions, int Insertions, double ErrorRate);
internal sealed record TranscribeSample(string Id, double AudioSeconds, double EncodeMs, double RequestMs,
    decimal? ReportedCost, string Reference, string Transcript, InsertionContext? Context = null);
internal sealed record TranscribeReport(List<TranscribeSample> Results);
internal sealed record CleanupRun(string Id, string Tier, string RequestedTier, string? ResponseTier,
    bool TierConfirmed, double CleanupMs, double AudioSeconds, double EncodeMs, double TranscribeRequestMs,
    decimal? TranscribeCost, string Reference, string RawTranscript, string? CleanedTranscript,
    Distance RawDistance, Distance? CleanedDistance, int InputTokens, int OutputTokens,
    int ReasoningTokens, decimal? CleanupCost, string? Error);
internal sealed record TierSummary(string Tier, int Samples, int Successful, int TierConfirmed,
    double MedianCleanupMs, double MeanCleanupMs, double RawMicroWer, double CleanMicroWer,
    decimal? CleanupCost, decimal? CombinedCost, double MedianSequentialPipelineMs,
    double MedianSequentialPipelineWithEncodeMs);
internal sealed record CleanupReport(DateTimeOffset RunAt, string Model, string Warning, string Prompt,
    TierSummary[] Summaries, List<CleanupRun> Runs, string? Provider = null, string? ReasoningEffort = null);
