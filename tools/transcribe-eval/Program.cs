using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using LocalWhisper;
using NAudio.Wave;

var source = Argument(args, "--source") ?? @"C:\Users\Liam\Downloads\WhiperFlow";
var output = Argument(args, "--output") ?? "artifacts/transcribe-eval-gpt-transcribe.json";
var model = Argument(args, "--model") ?? Transcriber.Model;
var style = Argument(args, "--style");
var sampleId = Argument(args, "--sample");
var pricePerHour = decimal.TryParse(Argument(args, "--price-per-hour"), out var configuredPrice)
    ? configuredPrice
    : model == "microsoft/mai-transcribe-2" ? 0.10m : 0.27m;
if (style is not null && style is not ("verbatim" or "clean"))
{
    Console.Error.WriteLine("--style must be verbatim or clean.");
    return 2;
}
if (!Directory.Exists(source))
{
    Console.Error.WriteLine($"Source folder does not exist: {source}");
    return 2;
}

var reviewedReferenceMode = Directory.GetFiles(source, "*.reviewed.txt").Length > 0;
var availablePairs = Directory.GetFiles(source, "*.wav")
    .Select(wav => {
        var id = Path.GetFileNameWithoutExtension(wav);
        var folder = Path.GetDirectoryName(wav)!;
        var reviewed = Path.Combine(folder, $"{id}.reviewed.txt");
        var provisional = Path.ChangeExtension(wav, ".txt");
        var reference = reviewedReferenceMode ? reviewed : provisional;
        return new Sample(id, wav, reference, reviewedReferenceMode ? "reviewed" : "provisional",
            Path.Combine(folder, $"{id}.dictionary.json"));
    })
    .Where(sample => File.Exists(sample.ReferencePath))
    .OrderBy(sample => int.TryParse(sample.Id, out var number) ? number : int.MaxValue)
    .ThenBy(sample => sample.Id, StringComparer.OrdinalIgnoreCase)
    .ToArray();
var skippedUnreviewed = reviewedReferenceMode
    ? Directory.GetFiles(source, "*.wav").Length - availablePairs.Length
    : 0;
var pairs = availablePairs;
if (sampleId is not null)
    pairs = pairs.Where(sample => string.Equals(sample.Id, sampleId, StringComparison.OrdinalIgnoreCase)).ToArray();
if (pairs.Length == 0)
{
    Console.Error.WriteLine(reviewedReferenceMode
        ? "No WAV/reviewed-TXT pairs found. Review the remaining samples or choose a reviewed sample ID."
        : "No WAV/TXT pairs found.");
    return 2;
}

var equivalences = EquivalencePolicy.Load(Path.Combine(source, "equivalence-policy.json"));

var key = Settings.LoadKey();
if (string.IsNullOrWhiteSpace(key))
{
    Console.Error.WriteLine("No saved OpenRouter key was found. Add one in Local Whisper Settings or set OPENROUTER_API_KEY.");
    return 2;
}

using var capture = new UsageCaptureHandler(new HttpClientHandler());
using var http = new HttpClient(capture) { Timeout = Timeout.InfiniteTimeSpan };
var results = new List<SampleResult>();

Console.WriteLine($"Transcription eval: model={model} style={style ?? "default"} pairs={pairs.Length}");
Console.WriteLine($"References: {(reviewedReferenceMode ? "reviewed canonicals" : "provisional Wispr output")}; skipped-unreviewed={skippedUnreviewed}; equivalence-policy={equivalences.Description}");
Console.WriteLine("Each file is sent once. The locally saved key is never printed or written to the report.");

foreach (var pair in pairs)
{
    try
    {
        var reference = (await File.ReadAllTextAsync(pair.ReferencePath)).Trim();
        var dictionaryTerms = ReadDictionary(pair.DictionaryPath);
        var wav = await File.ReadAllBytesAsync(pair.WavPath);
        double audioSeconds;
        using (var reader = new WaveFileReader(pair.WavPath)) audioSeconds = reader.TotalTime.TotalSeconds;

        var encodeWatch = Stopwatch.StartNew();
        var encoded = AudioEncoding.Compress(wav);
        encodeWatch.Stop();

        capture.Reset();
        var requestWatch = Stopwatch.StartNew();
        var transcript = await Transcribe(http, encoded.Bytes, encoded.Format, key, model, style, dictionaryTerms);
        requestWatch.Stop();

        var distance = WordDistance(reference, transcript, equivalences);
        var estimate = (decimal)audioSeconds / 3600m * pricePerHour;
        var result = new SampleResult(pair.Id, audioSeconds, wav.LongLength, encoded.Bytes.LongLength,
            encodeWatch.Elapsed.TotalMilliseconds, requestWatch.Elapsed.TotalMilliseconds,
            dictionaryTerms.Length, pair.ReferenceKind, reference, transcript, distance.ReferenceWords, distance.Substitutions,
            distance.Deletions, distance.Insertions, distance.ErrorRate,
            capture.UsageSeconds, capture.InputTokens, capture.OutputTokens,
            capture.TotalTokens, capture.Cost, estimate, null);
        results.Add(result);
        Console.WriteLine($"{pair.Id,2}: audio={audioSeconds,5:F1}s dict={dictionaryTerms.Length,3} mp3={encoded.Bytes.Length / 1024.0,6:F1}KiB encode={encodeWatch.Elapsed.TotalMilliseconds,5:F0}ms request={requestWatch.Elapsed.TotalMilliseconds,5:F0}ms WER={distance.ErrorRate,6:P1} S/D/I={distance.Substitutions}/{distance.Deletions}/{distance.Insertions} cost={Money(capture.Cost)}");
    }
    catch (Exception error)
    {
        results.Add(new SampleResult(pair.Id, 0, 0, 0, 0, 0, 0, pair.ReferenceKind, "", "", 0, 0, 0, 0, 0,
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
    Percentile(successful.Select(result => result.RequestMs), 0.90),
    Percentile(successful.Select(result => result.RequestMs), 0.95),
    successful.Length == 0 ? 0 : successful.Average(result => result.RequestMs),
    successful.Sum(result => result.Substitutions + result.Deletions + result.Insertions),
    successful.Sum(result => result.ReferenceWords),
    MicroWer(successful),
    successful.Length == 0 ? 0 : successful.Average(result => result.WordErrorRate),
    reportedCosts.Length == 0 ? null : reportedCosts.Sum(),
    reportedCosts.Length,
    successful.Sum(result => result.EstimatedCost));

Console.WriteLine($"Summary: success={aggregate.Successful}/{aggregate.Samples} audio={aggregate.AudioSeconds:F1}s median-request={aggregate.MedianRequestMs:F0}ms p90-request={aggregate.P90RequestMs:F0}ms p95-request={aggregate.P95RequestMs:F0}ms mean-request={aggregate.MeanRequestMs:F0}ms micro-WER={aggregate.MicroWordErrorRate:P1} macro-WER={aggregate.MacroWordErrorRate:P1} reported-cost={Money(aggregate.ReportedCost)} duration-estimate={Money(aggregate.EstimatedCost)}");

var report = new Report(DateTimeOffset.Now, source, model, style,
    reviewedReferenceMode
        ? "References are Liam's audio-reviewed canonicals. Accepted equivalences are applied before WER."
        : "Wispr Flow references may contain automatic editing and are not verbatim ground truth.",
    equivalences.Description, aggregate, results);
var fullOutput = Path.GetFullPath(output);
Directory.CreateDirectory(Path.GetDirectoryName(fullOutput)!);
await File.WriteAllTextAsync(fullOutput, JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
Console.WriteLine($"Private report: {fullOutput}");
return successful.Length == pairs.Length ? 0 : 1;

static Distance WordDistance(string reference, string hypothesis, EquivalencePolicy equivalences)
{
    var a = equivalences.Words(reference);
    var b = equivalences.Words(hypothesis);
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

static double Percentile(IEnumerable<double> source, double percentile)
{
    var values = source.Order().ToArray();
    if (values.Length == 0) return 0;
    var rank = Math.Max(1, (int)Math.Ceiling(percentile * values.Length));
    return values[rank - 1];
}

static string? Argument(string[] values, string name)
{
    var index = Array.IndexOf(values, name);
    return index >= 0 && index + 1 < values.Length ? values[index + 1] : null;
}

static string[] ReadDictionary(string path)
{
    if (!File.Exists(path)) return [];
    using var json = JsonDocument.Parse(File.ReadAllBytes(path));
    var terms = json.RootElement.ValueKind == JsonValueKind.Array
        ? json.RootElement
        : json.RootElement.TryGetProperty("terms", out var property) && property.ValueKind == JsonValueKind.Array
            ? property
            : throw new InvalidDataException($"Dictionary snapshot has no terms array: {path}");
    return Vocabulary.Normalize(terms.EnumerateArray().Select(value =>
        value.ValueKind == JsonValueKind.String ? value.GetString() : throw new InvalidDataException($"Dictionary term is not text: {path}")));
}

static async Task<string> Transcribe(HttpClient http, byte[] audio, string format, string key, string model, string? style,
    IReadOnlyList<string> dictionaryTerms)
{
    using var request = new HttpRequestMessage(HttpMethod.Post, "https://openrouter.ai/api/v1/audio/transcriptions");
    request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
    request.Headers.Add("X-Title", "Local Whisper Eval");
    var payload = new Dictionary<string, object>
    {
        ["model"] = model,
        ["input_audio"] = new { data = Convert.ToBase64String(audio), format }
    };
    if (model == Transcriber.MaiModel)
    {
        var azure = new Dictionary<string, object>();
        if (style is not null)
            azure["enhancedMode"] = new { modelOptions = new { transcribeStyle = style } };
        if (dictionaryTerms.Count > 0)
            azure["phraseList"] = new { phrases = dictionaryTerms };
        if (azure.Count > 0)
            payload["provider"] = new
            {
                options = new { azure }
            };
    }
    else if (dictionaryTerms.Count > 0)
        payload["provider"] = new
        {
            options = new
            {
                openai = new { keywords = dictionaryTerms }
            }
        };
    request.Content = new ByteArrayContent(JsonSerializer.SerializeToUtf8Bytes(payload));
    request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
    using var response = await http.SendAsync(request);
    var body = await response.Content.ReadAsByteArrayAsync();
    if (!response.IsSuccessStatusCode)
        throw new HttpRequestException($"HTTP {(int)response.StatusCode}: {Encoding.UTF8.GetString(body)}");
    using var json = JsonDocument.Parse(body);
    if (!json.RootElement.TryGetProperty("text", out var text) || text.ValueKind != JsonValueKind.String)
        throw new InvalidDataException("OpenRouter returned no transcript.");
    return text.GetString()!.Trim();
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

internal sealed record Sample(string Id, string WavPath, string ReferencePath, string ReferenceKind, string DictionaryPath);
internal sealed record Cell(int Cost, int Substitutions, int Deletions, int Insertions);
internal sealed record Distance(int ReferenceWords, int Substitutions, int Deletions, int Insertions, double ErrorRate);
internal sealed record SampleResult(string Id, double AudioSeconds, long WavBytes, long Mp3Bytes,
    double EncodeMs, double RequestMs, int DictionaryTerms, string ReferenceKind, string Reference, string Transcript, int ReferenceWords,
    int Substitutions, int Deletions, int Insertions, double WordErrorRate, double? UsageSeconds,
    int? InputTokens, int? OutputTokens, int? TotalTokens, decimal? ReportedCost,
    decimal EstimatedCost, string? Error);
internal sealed record Aggregate(int Samples, int Successful, double AudioSeconds, double MedianEncodeMs,
    double MedianRequestMs, double P90RequestMs, double P95RequestMs, double MeanRequestMs, int WordErrors, int ReferenceWords,
    double MicroWordErrorRate, double MacroWordErrorRate, decimal? ReportedCost, int ReportedCostSamples,
    decimal EstimatedCost);
internal sealed record Report(DateTimeOffset RunAt, string SourceFolder, string Model, string? Style, string ReferenceWarning,
    string EquivalencePolicy,
    Aggregate Aggregate, List<SampleResult> Results);

internal sealed class EquivalencePolicy
{
    private readonly bool ignoreDiacritics;
    private readonly bool normaliseNumbers;
    private readonly Dictionary<string, string> symbols;
    private readonly Dictionary<string, string> words;
    private readonly List<(string Token, string[] Variants)> phrases;

    private EquivalencePolicy(bool ignoreDiacritics, bool normaliseNumbers,
        Dictionary<string, string> symbols, Dictionary<string, string> words,
        List<(string Token, string[] Variants)> phrases, string description)
    {
        this.ignoreDiacritics = ignoreDiacritics;
        this.normaliseNumbers = normaliseNumbers;
        this.symbols = symbols;
        this.words = words;
        this.phrases = phrases;
        Description = description;
    }

    public string Description { get; }

    public static EquivalencePolicy Load(string path)
    {
        if (!File.Exists(path))
            return new(false, false, [], [], [], "none");
        using var json = JsonDocument.Parse(File.ReadAllBytes(path));
        var root = json.RootElement;
        var ignoreDiacritics = root.TryGetProperty("ignoreDiacritics", out var diacritics) && diacritics.GetBoolean();
        var normaliseNumbers = root.TryGetProperty("normaliseNumbers", out var numbers) && numbers.GetBoolean();
        var symbols = new Dictionary<string, string>(StringComparer.Ordinal);
        if (root.TryGetProperty("symbols", out var symbolObject))
            foreach (var property in symbolObject.EnumerateObject()) symbols[property.Name] = property.Value.GetString() ?? "";
        var words = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (root.TryGetProperty("wordGroups", out var wordGroups))
            foreach (var group in wordGroups.EnumerateArray())
            {
                var variants = group.EnumerateArray().Select(item => item.GetString() ?? "").Where(item => item.Length > 0).ToArray();
                if (variants.Length == 0) continue;
                foreach (var variant in variants) words[variant] = variants[0];
            }
        var phrases = new List<(string Token, string[] Variants)>();
        if (root.TryGetProperty("phraseGroups", out var phraseGroups))
        {
            var index = 0;
            foreach (var group in phraseGroups.EnumerateArray())
            {
                var variants = group.EnumerateArray().Select(item => item.GetString() ?? "").Where(item => item.Length > 0).ToArray();
                if (variants.Length > 0) phrases.Add(($"acceptedphrase{index++}", variants));
            }
        }
        return new(ignoreDiacritics, normaliseNumbers, symbols, words, phrases, Path.GetFileName(path));
    }

    public string[] Words(string value)
    {
        var normalized = value.ToLowerInvariant().Normalize(NormalizationForm.FormKD);
        if (ignoreDiacritics)
            normalized = string.Concat(normalized.Where(character => CharUnicodeInfo.GetUnicodeCategory(character) != UnicodeCategory.NonSpacingMark));
        normalized = normalized.Normalize(NormalizationForm.FormKC);
        foreach (var symbol in symbols) normalized = normalized.Replace(symbol.Key, symbol.Value, StringComparison.Ordinal);
        foreach (var phrase in phrases)
            foreach (var variant in phrase.Variants)
            {
                var escaped = Regex.Escape(NormalizeVariant(variant)).Replace(@"\ ", @"\s+");
                normalized = Regex.Replace(normalized, $@"(?<![\p{{L}}\p{{N}}]){escaped}(?![\p{{L}}\p{{N}}])", $" {phrase.Token} ");
            }
        return Regex.Matches(normalized, @"[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?")
            .Select(match => match.Value.Replace('’', '\''))
            .Select(word => words.TryGetValue(word, out var accepted) ? accepted : word)
            .Select(word => normaliseNumbers && NumberWords.TryGetValue(word, out var number) ? number : word)
            .ToArray();
    }

    private string NormalizeVariant(string value)
    {
        var normalized = value.ToLowerInvariant().Normalize(NormalizationForm.FormKD);
        if (ignoreDiacritics)
            normalized = string.Concat(normalized.Where(character => CharUnicodeInfo.GetUnicodeCategory(character) != UnicodeCategory.NonSpacingMark));
        return normalized.Normalize(NormalizationForm.FormKC);
    }

    private static readonly Dictionary<string, string> NumberWords = new(StringComparer.OrdinalIgnoreCase)
    {
        ["zero"] = "0", ["one"] = "1", ["two"] = "2", ["three"] = "3", ["four"] = "4",
        ["five"] = "5", ["six"] = "6", ["seven"] = "7", ["eight"] = "8", ["nine"] = "9",
        ["ten"] = "10"
    };
}
