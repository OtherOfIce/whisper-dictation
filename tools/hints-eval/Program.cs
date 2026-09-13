using System.Diagnostics;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using LocalWhisper;
using NAudio.Wave;

const string model = "openai/gpt-transcribe";
const string endpoint = "https://openrouter.ai/api/v1/audio/transcriptions";
var source = Argument(args, "--source") ?? @"C:\Users\Liam\Downloads\WhiperFlow";
var output = Path.GetFullPath(Argument(args, "--output") ?? "artifacts/hints-eval.json");
var glossary = new[] { "Astra", "Raikage", "immortality", "OpenRouter" };
var sampleIds = new[] { "6", "12", "9" };

var key = Settings.LoadKey();
if (string.IsNullOrWhiteSpace(key))
{
    Console.Error.WriteLine("No saved OpenRouter key was found. Add one in Local Whisper Settings or set OPENROUTER_API_KEY.");
    return 2;
}

var samples = new List<PreparedSample>();
foreach (var id in sampleIds)
{
    var wavPath = Path.Combine(source, id + ".wav");
    if (!File.Exists(wavPath))
    {
        Console.Error.WriteLine($"Missing sample: {wavPath}");
        return 2;
    }
    var wav = await File.ReadAllBytesAsync(wavPath);
    using var reader = new WaveFileReader(wavPath);
    var encoded = AudioEncoding.Compress(wav);
    samples.Add(new(id, reader.TotalTime.TotalSeconds, wav.LongLength, encoded.Bytes, encoded.Format,
        Convert.ToHexString(SHA256.HashData(encoded.Bytes)).ToLowerInvariant()));
}

Directory.CreateDirectory(Path.GetDirectoryName(output)!);
var report = new Report(
    StartedAt: DateTimeOffset.Now,
    CheckpointedAt: DateTimeOffset.Now,
    Completed: false,
    SourceFolder: source,
    Model: model,
    Endpoint: endpoint,
    EndpointProviderTag: "openai",
    EndpointName: "OpenAI | openai/gpt-transcribe-20260805",
    Glossary: glossary,
    HintsOptions: new Dictionary<string, object>
    {
        ["provider"] = new Dictionary<string, object>
        {
            ["options"] = new Dictionary<string, object>
            {
                ["openai"] = new Dictionary<string, object> { ["keywords"] = glossary }
            }
        }
    },
    Requests: []);
await Checkpoint(report, output);

using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(45) };
Console.WriteLine("Vocabulary hints evaluation: 3 samples, 2 repeats per condition, 12 requests maximum.");
Console.WriteLine($"Private checkpoint: {output}");

var sequence = 0;
foreach (var sample in samples)
foreach (var repeat in Enumerable.Range(1, 2))
foreach (var condition in new[] { "baseline", "hints" })
{
    sequence++;
    var useHints = condition == "hints";
    var watch = Stopwatch.StartNew();
    int? status = null;
    string? transcript = null;
    Usage? usage = null;
    string? error = null;
    string? responseId = null;
    try
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        request.Headers.Add("X-Title", "Local Whisper hints evaluation");
        object payload = useHints
            ? new
            {
                model,
                input_audio = new { data = Convert.ToBase64String(sample.Mp3), format = sample.Format },
                provider = new { options = new { openai = new { keywords = glossary } } }
            }
            : new
            {
                model,
                input_audio = new { data = Convert.ToBase64String(sample.Mp3), format = sample.Format }
            };
        request.Content = new ByteArrayContent(JsonSerializer.SerializeToUtf8Bytes(payload));
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        using var response = await http.SendAsync(request);
        status = (int)response.StatusCode;
        var body = await response.Content.ReadAsByteArrayAsync();
        using var json = JsonDocument.Parse(body);
        var root = json.RootElement;
        responseId = String(root, "id");
        if (response.IsSuccessStatusCode)
        {
            transcript = String(root, "text");
            if (transcript is null) error = "Successful response contained no text field.";
            if (root.TryGetProperty("usage", out var value)) usage = new(
                Double(value, "seconds"), Integer(value, "input_tokens"), Integer(value, "output_tokens"),
                Integer(value, "total_tokens"), Decimal(value, "cost"));
        }
        else
        {
            error = ErrorMessage(root) ?? $"HTTP {status}";
        }
    }
    catch (Exception exception)
    {
        error = $"{exception.GetType().Name}: {exception.Message}";
    }
    watch.Stop();
    report.Requests.Add(new RequestResult(sequence, sample.Id, repeat, condition, useHints,
        sample.AudioSeconds, sample.WavBytes, sample.Mp3.LongLength, sample.Format, sample.Mp3Sha256,
        status, status is >= 200 and <= 299, watch.Elapsed.TotalMilliseconds, transcript, usage,
        responseId, error));
    report = report with { CheckpointedAt = DateTimeOffset.Now };
    await Checkpoint(report, output);
    Console.WriteLine($"{sequence,2}/12 sample={sample.Id,2} repeat={repeat} {condition,-8} HTTP={status?.ToString() ?? "none",3} latency={watch.Elapsed.TotalMilliseconds,6:F0}ms cost={Money(usage?.Cost)} text={JsonSerializer.Serialize(transcript)}{(error is null ? "" : " error=" + error)}");
}

report = report with { CheckpointedAt = DateTimeOffset.Now, Completed = true };
await Checkpoint(report, output);
return report.Requests.All(value => value.HttpAccepted && value.Error is null) ? 0 : 1;

static async Task Checkpoint(Report report, string output)
{
    var temporary = output + ".tmp";
    await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
    File.Move(temporary, output, true);
}

static string? Argument(string[] values, string name)
{
    var index = Array.IndexOf(values, name);
    return index >= 0 && index + 1 < values.Length ? values[index + 1] : null;
}

static string? String(JsonElement value, string name) =>
    value.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.String ? property.GetString() : null;
static int? Integer(JsonElement value, string name) =>
    value.TryGetProperty(name, out var property) && property.TryGetInt32(out var number) ? number : null;
static double? Double(JsonElement value, string name) =>
    value.TryGetProperty(name, out var property) && property.TryGetDouble(out var number) ? number : null;
static decimal? Decimal(JsonElement value, string name) =>
    value.TryGetProperty(name, out var property) && property.TryGetDecimal(out var number) ? number : null;
static string? ErrorMessage(JsonElement root)
{
    if (!root.TryGetProperty("error", out var error)) return null;
    return error.ValueKind == JsonValueKind.String ? error.GetString() : String(error, "message") ?? error.ToString();
}
static string Money(decimal? value) => value.HasValue ? $"${value:F6}" : "n/a";

internal sealed record PreparedSample(string Id, double AudioSeconds, long WavBytes, byte[] Mp3, string Format, string Mp3Sha256);
internal sealed record Usage(double? Seconds, int? InputTokens, int? OutputTokens, int? TotalTokens, decimal? Cost);
internal sealed record RequestResult(int Sequence, string SampleId, int Repeat, string Condition, bool SentProviderOptions,
    double AudioSeconds, long WavBytes, long Mp3Bytes, string Format, string Mp3Sha256, int? HttpStatus,
    bool HttpAccepted, double LatencyMs, string? Transcript, Usage? Usage, string? ResponseId, string? Error);
internal sealed record Report(DateTimeOffset StartedAt, DateTimeOffset CheckpointedAt, bool Completed,
    string SourceFolder, string Model, string Endpoint, string EndpointProviderTag, string EndpointName,
    string[] Glossary, Dictionary<string, object> HintsOptions, List<RequestResult> Requests);
