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
var outputArgument = Argument(args, "--output");
var output = outputArgument ?? "artifacts/transcribe-eval-gpt-transcribe.json";
var rescore = Argument(args, "--rescore");
var model = Argument(args, "--model") ?? Transcriber.Model;
var service = (Argument(args, "--service") ?? "openrouter").ToLowerInvariant();
var style = Argument(args, "--style");
var provider = Argument(args, "--provider");
var language = Argument(args, "--language");
var locales = Argument(args, "--locales");
var xaiFormat = bool.TryParse(Argument(args, "--xai-format"), out var configuredXaiFormat) && configuredXaiFormat;
var fillerWords = bool.TryParse(Argument(args, "--filler-words"), out var configuredFillerWords) && configuredFillerWords;
var dictionaryEnabled = !bool.TryParse(Argument(args, "--dictionary"), out var configuredDictionary) || configuredDictionary;
var vadThreshold = double.TryParse(Argument(args, "--vad-threshold"), CultureInfo.InvariantCulture, out var configuredVadThreshold)
    ? configuredVadThreshold
    : (double?)null;
var sampleId = Argument(args, "--sample");
var parallelism = int.TryParse(Argument(args, "--parallelism"), out var configuredParallelism)
    ? configuredParallelism
    : 4;
const string MuseModel = "meta/muse-voice-transcribe-1.0";
var pricePerHour = decimal.TryParse(Argument(args, "--price-per-hour"), out var configuredPrice)
    ? configuredPrice
    : model switch
    {
        "microsoft/mai-transcribe-2" => 0.10m,
        "openai/whisper-large-v3-turbo" => 0.04m,
        "openai/whisper-large-v3" => 0.04m,
        MuseModel => 0.18m,
        "grok-voice-transcribe-2.0" => 0.10m,
        "grok-voice-transcribe-1.0" => 0.10m,
        _ => 0.27m
    };
if (service is not ("openrouter" or "xai"))
{
    Console.Error.WriteLine("--service must be openrouter or xai.");
    return 2;
}
if (style is not null && style is not ("verbatim" or "clean"))
{
    Console.Error.WriteLine("--style must be verbatim or clean.");
    return 2;
}
if (parallelism < 1)
{
    Console.Error.WriteLine("--parallelism must be at least 1.");
    return 2;
}
if (vadThreshold is < 0 or > 1)
{
    Console.Error.WriteLine("--vad-threshold must be between 0 and 1.");
    return 2;
}
if (service == "xai" && xaiFormat && string.IsNullOrWhiteSpace(language))
{
    Console.Error.WriteLine("--xai-format true requires --language.");
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

if (rescore is not null)
{
    if (!File.Exists(rescore))
    {
        Console.Error.WriteLine($"Report does not exist: {rescore}");
        return 2;
    }
    var prior = JsonSerializer.Deserialize<Report>(await File.ReadAllBytesAsync(rescore))
        ?? throw new InvalidDataException("Could not read the report.");
    var rescored = prior.Results.Select(result =>
    {
        if (result.Error is not null) return result;
        var distance = WordDistance(result.Reference, result.Transcript, equivalences);
        return result with
        {
            ReferenceWords = distance.ReferenceWords,
            Substitutions = distance.Substitutions,
            Deletions = distance.Deletions,
            Insertions = distance.Insertions,
            WordErrorRate = distance.ErrorRate
        };
    }).ToArray();
    var rescoredReport = prior with
    {
        RunAt = DateTimeOffset.Now,
        EquivalencePolicy = equivalences.Description,
        Aggregate = Summarize(rescored, prior.Aggregate.Samples),
        Results = rescored
    };
    var rescoreOutput = Path.GetFullPath(outputArgument ?? Path.Combine(
        Path.GetDirectoryName(rescore) ?? "",
        Path.GetFileNameWithoutExtension(rescore) + "-rescored.json"));
    Directory.CreateDirectory(Path.GetDirectoryName(rescoreOutput)!);
    await File.WriteAllTextAsync(rescoreOutput, JsonSerializer.Serialize(rescoredReport, new JsonSerializerOptions { WriteIndented = true }));
    Console.WriteLine($"Rescored report: {rescoreOutput}");
    Console.WriteLine($"Summary: success={rescoredReport.Aggregate.Successful}/{rescoredReport.Aggregate.Samples} micro-WER={rescoredReport.Aggregate.MicroWordErrorRate:P2} macro-WER={rescoredReport.Aggregate.MacroWordErrorRate:P2}");
    return 0;
}

var key = service == "xai"
    ? Environment.GetEnvironmentVariable("XAI_API_KEY")
        ?? Environment.GetEnvironmentVariable("XAI_API_KEY", EnvironmentVariableTarget.User)
        ?? ""
    : Settings.LoadKey();
if (string.IsNullOrWhiteSpace(key))
{
    Console.Error.WriteLine(service == "xai"
        ? "XAI_API_KEY is not set. Set it in this shell before running a direct xAI benchmark."
        : "No saved OpenRouter key was found. Add one in Local Whisper Settings or set OPENROUTER_API_KEY.");
    return 2;
}

var results = new SampleResult[pairs.Length];

Console.WriteLine($"Transcription eval: service={service} model={model} style={style ?? "default"} provider={provider ?? "auto"} language={language ?? "auto"} locales={locales ?? "auto"} pairs={pairs.Length} parallelism={parallelism}");
Console.WriteLine($"References: {(reviewedReferenceMode ? "reviewed canonicals" : "provisional Wispr output")}; skipped-unreviewed={skippedUnreviewed}; equivalence-policy={equivalences.Description}");
Console.WriteLine("Each file is sent once. The API key is never printed or written to the report.");

await Parallel.ForEachAsync(Enumerable.Range(0, pairs.Length), new ParallelOptions { MaxDegreeOfParallelism = parallelism },
    async (index, _) => results[index] = await Evaluate(pairs[index]));

async Task<SampleResult> Evaluate(Sample pair)
{
    try
    {
        var reference = (await File.ReadAllTextAsync(pair.ReferencePath)).Trim();
        var dictionaryTerms = dictionaryEnabled ? ReadDictionary(pair.DictionaryPath) : [];
        var wav = await File.ReadAllBytesAsync(pair.WavPath);
        double audioSeconds;
        using (var reader = new WaveFileReader(pair.WavPath)) audioSeconds = reader.TotalTime.TotalSeconds;

        var encodeWatch = Stopwatch.StartNew();
        var encoded = model == MuseModel ? (Bytes: wav, Format: "wav") : AudioEncoding.Compress(wav);
        encodeWatch.Stop();

        using var capture = new UsageCaptureHandler(new HttpClientHandler());
        using var http = new HttpClient(capture) { Timeout = Timeout.InfiniteTimeSpan };
        var requestWatch = Stopwatch.StartNew();
        var transcript = await Transcribe(http, encoded.Bytes, encoded.Format, key, service, model, style, dictionaryTerms,
            provider, language, locales, xaiFormat, fillerWords, vadThreshold);
        requestWatch.Stop();

        var distance = WordDistance(reference, transcript, equivalences);
        var estimate = (decimal)audioSeconds / 3600m * pricePerHour;
        var result = new SampleResult(pair.Id, audioSeconds, wav.LongLength, encoded.Bytes.LongLength, encoded.Format,
            encodeWatch.Elapsed.TotalMilliseconds, requestWatch.Elapsed.TotalMilliseconds,
            dictionaryTerms.Length, pair.ReferenceKind, reference, transcript, distance.ReferenceWords, distance.Substitutions,
            distance.Deletions, distance.Insertions, distance.ErrorRate,
            capture.UsageSeconds, capture.InputTokens, capture.OutputTokens,
            capture.TotalTokens, capture.Cost, estimate, null);
        Console.WriteLine($"{pair.Id,2}: audio={audioSeconds,5:F1}s dict={dictionaryTerms.Length,3} upload={encoded.Format}:{encoded.Bytes.Length / 1024.0,6:F1}KiB encode={encodeWatch.Elapsed.TotalMilliseconds,5:F0}ms request={requestWatch.Elapsed.TotalMilliseconds,5:F0}ms WER={distance.ErrorRate,6:P1} S/D/I={distance.Substitutions}/{distance.Deletions}/{distance.Insertions} cost={Money(capture.Cost)}");
        return result;
    }
    catch (Exception error)
    {
        var result = new SampleResult(pair.Id, 0, 0, 0, "", 0, 0, 0, pair.ReferenceKind, "", "", 0, 0, 0, 0, 0,
            null, null, null, null, null, 0, $"{error.GetType().Name}: {error.Message}");
        Console.WriteLine($"{pair.Id,2}: ERROR {error.Message}");
        return result;
    }
}

var successful = results.Where(result => result.Error is null).ToArray();
var aggregate = Summarize(results, pairs.Length);

Console.WriteLine($"Summary: success={aggregate.Successful}/{aggregate.Samples} audio={aggregate.AudioSeconds:F1}s median-request={aggregate.MedianRequestMs:F0}ms p90-request={aggregate.P90RequestMs:F0}ms p95-request={aggregate.P95RequestMs:F0}ms mean-request={aggregate.MeanRequestMs:F0}ms micro-WER={aggregate.MicroWordErrorRate:P1} macro-WER={aggregate.MacroWordErrorRate:P1} reported-cost={Money(aggregate.ReportedCost)} duration-estimate={Money(aggregate.EstimatedCost)}");

var report = new Report(DateTimeOffset.Now, source, service, model, style, language, xaiFormat, fillerWords, vadThreshold,
    dictionaryEnabled,
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

static Aggregate Summarize(IEnumerable<SampleResult> source, int samples)
{
    var successful = source.Where(result => result.Error is null).ToArray();
    var reportedCosts = successful.Where(result => result.ReportedCost.HasValue).Select(result => result.ReportedCost!.Value).ToArray();
    return new Aggregate(
        samples,
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

static Task<string> Transcribe(HttpClient http, byte[] audio, string format, string key, string service, string model, string? style,
    IReadOnlyList<string> dictionaryTerms, string? provider = null, string? language = null, string? locales = null,
    bool xaiFormat = false, bool fillerWords = false, double? vadThreshold = null) =>
    service == "xai"
        ? TranscribeXai(http, audio, format, key, model, dictionaryTerms, language, xaiFormat, fillerWords, vadThreshold)
        : TranscribeOpenRouter(http, audio, format, key, model, style, dictionaryTerms, provider, language, locales);

static async Task<string> TranscribeOpenRouter(HttpClient http, byte[] audio, string format, string key, string model, string? style,
    IReadOnlyList<string> dictionaryTerms, string? provider = null, string? language = null, string? locales = null)
{
    using var request = new HttpRequestMessage(HttpMethod.Post, "https://openrouter.ai/api/v1/audio/transcriptions");
    request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
    request.Headers.Add("X-Title", "Local Whisper Eval");
    var payload = new Dictionary<string, object>
    {
        ["model"] = model,
        ["input_audio"] = new { data = Convert.ToBase64String(audio), format }
    };
    if (!string.IsNullOrWhiteSpace(language))
        payload["language"] = language!;
    Dictionary<string, object>? providerOptions = null;
    if (model == Transcriber.MaiModel)
    {
        var azure = new Dictionary<string, object>();
        if (style is not null)
            azure["enhancedMode"] = new { modelOptions = new { transcribeStyle = style } };
        if (!string.IsNullOrWhiteSpace(locales))
            azure["locales"] = locales.Split(',').Select(part => part.Trim()).Where(part => part.Length > 0).ToArray();
        if (dictionaryTerms.Count > 0)
            azure["phraseList"] = new { phrases = dictionaryTerms };
        if (azure.Count > 0)
            providerOptions = new Dictionary<string, object> { ["azure"] = azure };
    }
    else if (model == MuseModel && dictionaryTerms.Count > 0)
        providerOptions = new Dictionary<string, object> { ["meta"] = new { keywords = dictionaryTerms } };
    else if (dictionaryTerms.Count > 0)
    {
        providerOptions = new Dictionary<string, object> { ["openai"] = new { keywords = dictionaryTerms } };
        if (model is "openai/whisper-large-v3-turbo" or "openai/whisper-large-v3")
            providerOptions["groq"] = new { prompt = "Expected vocabulary: " + string.Join(", ", dictionaryTerms) };
    }
    if (!string.IsNullOrWhiteSpace(provider) || providerOptions is not null)
    {
        var providerPayload = new Dictionary<string, object>();
        if (!string.IsNullOrWhiteSpace(provider))
        {
            providerPayload["order"] = new[] { provider! };
            providerPayload["allow_fallbacks"] = false;
        }
        if (providerOptions is not null)
            providerPayload["options"] = providerOptions;
        payload["provider"] = providerPayload;
    }
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

static async Task<string> TranscribeXai(HttpClient http, byte[] audio, string format, string key, string model,
    IReadOnlyList<string> dictionaryTerms, string? language, bool formatText, bool fillerWords, double? vadThreshold)
{
    if (dictionaryTerms.Count > 100)
        throw new InvalidOperationException($"xAI accepts at most 100 keyterms; this sample has {dictionaryTerms.Count}.");
    var longTerm = dictionaryTerms.FirstOrDefault(term => term.Length > 50);
    if (longTerm is not null)
        throw new InvalidOperationException($"xAI keyterms are limited to 50 characters; '{longTerm}' is longer.");

    using var request = new HttpRequestMessage(HttpMethod.Post, "https://api.x.ai/v1/stt");
    request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
    using var form = new MultipartFormDataContent();
    form.Add(new StringContent(model), "model");
    if (!string.IsNullOrWhiteSpace(language)) form.Add(new StringContent(language), "language");
    if (formatText) form.Add(new StringContent("true"), "format");
    if (fillerWords) form.Add(new StringContent("true"), "filler_words");
    if (vadThreshold.HasValue)
        form.Add(new StringContent(vadThreshold.Value.ToString(CultureInfo.InvariantCulture)), "vad_threshold");
    foreach (var term in dictionaryTerms) form.Add(new StringContent(term), "keyterm");
    var file = new ByteArrayContent(audio);
    file.Headers.ContentType = new MediaTypeHeaderValue(format.ToLowerInvariant() switch
    {
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        _ => "application/octet-stream"
    });
    form.Add(file, "file", $"audio.{format.ToLowerInvariant()}"); // xAI requires file to be the final multipart field.
    request.Content = form;

    using var response = await http.SendAsync(request);
    var body = await response.Content.ReadAsByteArrayAsync();
    if (!response.IsSuccessStatusCode)
        throw new HttpRequestException($"HTTP {(int)response.StatusCode}: {Encoding.UTF8.GetString(body)}");
    using var json = JsonDocument.Parse(body);
    if (!json.RootElement.TryGetProperty("text", out var text) || text.ValueKind != JsonValueKind.String)
        throw new InvalidDataException("xAI returned no transcript.");
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
                Cost = Decimal(usage, "cost") ?? (Decimal(usage, "cost_in_usd_ticks") is { } ticks ? ticks / 10_000_000_000m : null);
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
internal sealed record SampleResult(string Id, double AudioSeconds, long WavBytes, long UploadBytes, string UploadFormat,
    double EncodeMs, double RequestMs, int DictionaryTerms, string ReferenceKind, string Reference, string Transcript, int ReferenceWords,
    int Substitutions, int Deletions, int Insertions, double WordErrorRate, double? UsageSeconds,
    int? InputTokens, int? OutputTokens, int? TotalTokens, decimal? ReportedCost,
    decimal EstimatedCost, string? Error);
internal sealed record Aggregate(int Samples, int Successful, double AudioSeconds, double MedianEncodeMs,
    double MedianRequestMs, double P90RequestMs, double P95RequestMs, double MeanRequestMs, int WordErrors, int ReferenceWords,
    double MicroWordErrorRate, double MacroWordErrorRate, decimal? ReportedCost, int ReportedCostSamples,
    decimal EstimatedCost);
internal sealed record Report(DateTimeOffset RunAt, string SourceFolder, string Service, string Model, string? Style,
    string? Language, bool XaiFormat, bool FillerWords, double? VadThreshold, bool DictionaryEnabled, string ReferenceWarning,
    string EquivalencePolicy,
    Aggregate Aggregate, SampleResult[] Results);

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
