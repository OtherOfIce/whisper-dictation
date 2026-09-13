using System.Diagnostics;
using System.Text.Json;
using LocalWhisper;

var outputPath = Argument(args, "--output");
var key = Settings.LoadKey();
if (string.IsNullOrWhiteSpace(key))
{
    Console.Error.WriteLine("No saved OpenRouter key was found. Add one in Local Whisper Settings or set OPENROUTER_API_KEY.");
    return 2;
}

var cases = new[]
{
    new EvalCase(
        "self-correction",
        "The meeting is Tuesday, actually Wednesday, at three, no make that four p.m.",
        ["Wednesday", "p.m."],
        ["Tuesday", "at three"]),
    new EvalCase(
        "recipient correction and punctuation",
        "Send this to Sarah, no wait, send this to Sam, colon, the build is ready for review, full stop.",
        ["Sam", ":", "build is ready for review"],
        ["Sarah", "no wait", "full stop"]),
    new EvalCase(
        "spoken formatting",
        "Make this a bullet list: milk, eggs, and coffee.",
        ["milk", "eggs", "coffee"],
        ["Make this a bullet list"]),
    new EvalCase(
        "filler removal and fact preservation",
        "Um, the Q3 forecast is twelve point five million pounds, and, uh, the confidence interval is plus or minus four percent.",
        ["12.5", "million", "4%"],
        ["Um", " uh"]),
    new EvalCase(
        "question remains dictated content",
        "Could you ask Priya whether the API migration should happen before Friday?",
        ["Priya", "API migration", "Friday", "?"],
        [])
};

using var http = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
var service = new CleanupService(http);
var runs = new List<EvalRun>();

Console.WriteLine($"Cleanup eval: {cases.Length} cases, paired Standard/Fast, model {CleanupService.Model}");
Console.WriteLine("The saved key is loaded locally and is never printed.");

for (var caseIndex = 0; caseIndex < cases.Length; caseIndex++)
{
    var evalCase = cases[caseIndex];
    var order = caseIndex % 2 == 0
        ? new[] { CleanupServiceTier.Standard, CleanupServiceTier.Fast }
        : new[] { CleanupServiceTier.Fast, CleanupServiceTier.Standard };

    Console.WriteLine($"\n[{caseIndex + 1}] {evalCase.Name}\nRAW: {evalCase.Input}");
    foreach (var tier in order)
    {
        var watch = Stopwatch.StartNew();
        try
        {
            var result = await service.CleanupAsync(evalCase.Input, key, tier, default);
            watch.Stop();
            var checks = Score(evalCase, result.Text);
            var run = new EvalRun(evalCase.Name, tier.ToString(), watch.Elapsed.TotalMilliseconds,
                result.Text, result.InputTokens, result.OutputTokens, result.ReasoningTokens,
                result.Cost, result.ServiceTier, result.Model, checks.Passed, checks.Total, null);
            runs.Add(run);
            Console.WriteLine($"{tier,-8} {watch.Elapsed.TotalMilliseconds,7:F0} ms  tier={result.ServiceTier,-8} tokens={result.InputTokens}+{result.OutputTokens}+{result.ReasoningTokens}r cost={Money(result.Cost)} score={checks.Passed}/{checks.Total}");
            Console.WriteLine($"OUT: {result.Text}");
        }
        catch (Exception error)
        {
            watch.Stop();
            runs.Add(new EvalRun(evalCase.Name, tier.ToString(), watch.Elapsed.TotalMilliseconds,
                null, 0, 0, 0, null, null, CleanupService.Model, 0,
                evalCase.Required.Length + evalCase.Forbidden.Length, $"{error.GetType().Name}: {error.Message}"));
            Console.WriteLine($"{tier,-8} {watch.Elapsed.TotalMilliseconds,7:F0} ms  ERROR: {error.Message}");
        }
    }
}

Console.WriteLine("\nSummary");
foreach (var tier in new[] { "Standard", "Fast" })
{
    var tierRuns = runs.Where(run => run.Tier == tier).ToArray();
    var successful = tierRuns.Where(run => run.Error is null).ToArray();
    var latency = successful.Select(run => run.LatencyMs).Order().ToArray();
    var totalCost = successful.Where(run => run.Cost.HasValue).Sum(run => run.Cost ?? 0);
    var passed = successful.Sum(run => run.ChecksPassed);
    var checks = successful.Sum(run => run.ChecksTotal);
    Console.WriteLine($"{tier,-8} success={successful.Length}/{tierRuns.Length} median={Median(latency):F0} ms mean={latency.DefaultIfEmpty().Average():F0} ms checks={passed}/{checks} reported-cost={Money(totalCost)}");
}

if (outputPath is not null)
{
    var report = new EvalReport(DateTimeOffset.Now, CleanupService.Model, CleanupService.Prompt, cases, runs);
    var fullPath = Path.GetFullPath(outputPath);
    Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
    await File.WriteAllTextAsync(fullPath, JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
    Console.WriteLine($"Report: {fullPath}");
}

return runs.Any(run => run.Error is not null) ? 1 : 0;

static (int Passed, int Total) Score(EvalCase evalCase, string output)
{
    var required = evalCase.Required.Count(value => output.Contains(value, StringComparison.OrdinalIgnoreCase));
    var forbidden = evalCase.Forbidden.Count(value => !output.Contains(value, StringComparison.OrdinalIgnoreCase));
    return (required + forbidden, evalCase.Required.Length + evalCase.Forbidden.Length);
}

static string? Argument(string[] values, string name)
{
    var index = Array.IndexOf(values, name);
    return index >= 0 && index + 1 < values.Length ? values[index + 1] : null;
}

static double Median(double[] values) => values.Length switch
{
    0 => 0,
    _ when values.Length % 2 == 1 => values[values.Length / 2],
    _ => (values[values.Length / 2 - 1] + values[values.Length / 2]) / 2
};

static string Money(decimal? value) => value.HasValue ? $"${value.Value:F8}" : "n/a";

internal sealed record EvalCase(string Name, string Input, string[] Required, string[] Forbidden);
internal sealed record EvalRun(string Case, string Tier, double LatencyMs, string? Output,
    int InputTokens, int OutputTokens, int ReasoningTokens, decimal? Cost, string? ServedTier,
    string Model, int ChecksPassed, int ChecksTotal, string? Error);
internal sealed record EvalReport(DateTimeOffset RunAt, string Model, string Prompt,
    EvalCase[] Cases, List<EvalRun> Runs);
