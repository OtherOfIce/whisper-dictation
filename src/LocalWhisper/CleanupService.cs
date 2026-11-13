using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace LocalWhisper;

internal enum CleanupServiceTier { Standard, Fast }
internal enum CleanupGateway { OpenRouter, Vercel }
internal sealed record CleanupRequestProfile(string Model, string ReasoningEffort, string? Provider = null,
    bool SendServiceTier = true, int MinimumCompletionTokens = 0, string? Prompt = null,
    CleanupGateway Gateway = CleanupGateway.OpenRouter, TimeSpan? Timeout = null);
internal sealed record CleanupResult(string Text, int InputTokens, int OutputTokens, int ReasoningTokens,
    decimal? Cost, string ServiceTier, string Model);

internal sealed class CleanupService(HttpClient client, IReadOnlyList<string>? vocabulary = null)
{
    public const string Model = "openai/gpt-6-luna";
    public const string Off = "off";
    public const string Luna = "luna";
    public const string LunaFast = "luna-fast";
    public const string DeepSeek = "deepseek";
    public const string DeepSeekModel = "deepseek/deepseek-v4.1-flash-fast";
    internal static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(15);

    // Each cleanup model has its own prompt in shared/cleanup/, tuned against tools/cleanup-eval.
    // Luna's prompt is shared with the Android keyboard.
    internal static readonly string Prompt = LoadPrompt("LunaCleanupPrompt");
    internal static readonly string DeepSeekPrompt = LoadPrompt("DeepSeekCleanupPrompt");

    public static bool IsMode(string? mode) => mode is Off or Luna or LunaFast or DeepSeek;
    public static bool UsesGateway(string mode) => mode == DeepSeek;

    // DeepSeek usually finishes in about 0.3 s, so a stalled request falls back to Luna quickly.
    // Longer dictations need more output time, so the limit grows with the transcript.
    internal static CleanupRequestProfile DeepSeekProfile(string text) => new(DeepSeekModel, "none",
        SendServiceTier: false, Prompt: DeepSeekPrompt, Gateway: CleanupGateway.Vercel,
        Timeout: TimeSpan.FromMilliseconds(Math.Min(DefaultTimeout.TotalMilliseconds, 2500 + 2 * Encoding.UTF8.GetByteCount(text))));

    public async Task<string> CleanAsync(string text, string key, string mode, CancellationToken cancellation)
        => await CleanAsync(text, null, key, mode, cancellation).ConfigureAwait(false);

    public async Task<string> CleanAsync(string text, InsertionContext? context, string key, string mode, CancellationToken cancellation)
    {
        if (mode == Off || string.IsNullOrWhiteSpace(text)) return text;
        if (!IsMode(mode)) throw new ArgumentOutOfRangeException(nameof(mode));
        if (mode == DeepSeek)
            return (await CleanupAsync(text, context, key, CleanupServiceTier.Standard, DeepSeekProfile(text), cancellation).ConfigureAwait(false)).Text;

        return (await CleanupAsync(text, context, key,
            mode == LunaFast ? CleanupServiceTier.Fast : CleanupServiceTier.Standard, cancellation).ConfigureAwait(false)).Text;
    }

    internal async Task<CleanupResult> CleanupAsync(string text, string key, CleanupServiceTier tier, CancellationToken cancellation)
        => await CleanupAsync(text, null, key, tier, cancellation).ConfigureAwait(false);

    internal async Task<CleanupResult> CleanupAsync(string text, InsertionContext? context, string key, CleanupServiceTier tier, CancellationToken cancellation)
        => await CleanupAsync(text, context, key, tier,
            new CleanupRequestProfile(Model, "none"), cancellation).ConfigureAwait(false);

    internal async Task<CleanupResult> CleanupAsync(string text, InsertionContext? context, string key,
        CleanupServiceTier tier, CleanupRequestProfile profile, CancellationToken cancellation)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(profile.Timeout ?? DefaultTimeout);
        try { return await SendAsync(text, context, key, tier, profile, timeout.Token).ConfigureAwait(false); }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested)
        {
            throw new TimeoutException("AI cleanup timed out.");
        }
    }

    internal static string Endpoint(CleanupGateway gateway) => gateway == CleanupGateway.Vercel
        ? "https://ai-gateway.vercel.sh/v1/chat/completions" : "https://openrouter.ai/api/v1/chat/completions";

    // Opening a TLS connection costs about 120 ms more than reusing one. A free, unauthenticated HEAD
    // request while the user is still speaking leaves a pooled connection ready for the cleanup request.
    public static async Task WarmUpAsync(HttpClient client, string mode)
    {
        if (!IsMode(mode) || mode == Off) return;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            using var request = new HttpRequestMessage(HttpMethod.Head, Endpoint(UsesGateway(mode) ? CleanupGateway.Vercel : CleanupGateway.OpenRouter));
            using var response = await client.SendAsync(request, timeout.Token).ConfigureAwait(false);
        }
        catch (Exception) { } // Best effort: the cleanup request opens its own connection if this fails.
    }

    private async Task<CleanupResult> SendAsync(string text, InsertionContext? context, string key,
        CleanupServiceTier tier, CleanupRequestProfile profile, CancellationToken cancellation)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, Endpoint(profile.Gateway));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        request.Headers.Add("X-Title", "Local Whisper");
        var payload = new Dictionary<string, object?>
        {
            ["model"] = profile.Model,
            ["reasoning_effort"] = profile.ReasoningEffort,
            ["max_completion_tokens"] = Math.Max(OutputTokenBudget(text), profile.MinimumCompletionTokens),
            ["messages"] = new[]
            {
                new { role = "system", content = profile.Prompt ?? Prompt },
                new { role = "user", content = UserContent(text, context, vocabulary) }
            }
        };
        if (profile.SendServiceTier)
            payload["service_tier"] = tier == CleanupServiceTier.Fast ? "priority" : "default";
        if (profile.Provider is not null)
            payload[profile.Gateway == CleanupGateway.Vercel ? "providerOptions" : "provider"] = profile.Gateway == CleanupGateway.Vercel
                ? new { gateway = new { only = new[] { profile.Provider } } }
                : new { only = new[] { profile.Provider }, allow_fallbacks = false };
        request.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");

        var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation).ConfigureAwait(false);
        using (response)
        {
            if (!response.IsSuccessStatusCode)
                throw new HttpRequestException($"AI cleanup failed (HTTP {(int)response.StatusCode}).");

            using var body = await JsonDocument.ParseAsync(
                await response.Content.ReadAsStreamAsync(cancellation).ConfigureAwait(false),
                cancellationToken: cancellation).ConfigureAwait(false);
            if (!body.RootElement.TryGetProperty("choices", out var choices) || choices.ValueKind != JsonValueKind.Array || choices.GetArrayLength() == 0)
                throw new InvalidDataException("The cleanup model returned no cleaned transcript.");
            var choice = choices[0];
            if (ReadString(choice, "finish_reason") is "length" or "max_tokens" ||
                ReadString(choice, "native_finish_reason") is "length" or "max_tokens")
                throw new InvalidDataException("The cleanup model truncated the cleaned transcript.");
            if (!choice.TryGetProperty("message", out var message) ||
                !message.TryGetProperty("content", out var content) || content.ValueKind != JsonValueKind.String ||
                string.IsNullOrWhiteSpace(content.GetString()))
                throw new InvalidDataException("The cleanup model returned no cleaned transcript.");
            var root = body.RootElement;
            var usage = root.TryGetProperty("usage", out var usageValue) ? usageValue : default;
            var details = usage.ValueKind == JsonValueKind.Object && usage.TryGetProperty("completion_tokens_details", out var detailsValue) ? detailsValue : default;
            var modelOutput = content.GetString()!.Trim();
            ValidateInsertion(modelOutput, context);
            var cleaned = InsertionFitter.Fit(modelOutput, context);
            ValidateInsertion(cleaned, context);
            return new CleanupResult(
                cleaned,
                ReadInt(usage, "prompt_tokens"),
                ReadInt(usage, "completion_tokens"),
                ReadInt(details, "reasoning_tokens"),
                ReadDecimal(usage, "cost"),
                ReadString(root, "service_tier") ?? (tier == CleanupServiceTier.Fast ? "priority" : "default"),
                ReadString(root, "model") ?? profile.Model);
        }
    }

    private static int ReadInt(JsonElement parent, string name) =>
        parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(name, out var value) && value.TryGetInt32(out var number) ? number : 0;
    private static decimal? ReadDecimal(JsonElement parent, string name) =>
        parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(name, out var value) && value.TryGetDecimal(out var number) ? number : null;
    private static string? ReadString(JsonElement parent, string name) =>
        parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    internal static int OutputTokenBudget(string text) => Math.Clamp(Encoding.UTF8.GetByteCount(text) + 256, 512, 16384);
    private static string UserContent(string text, InsertionContext? context, IReadOnlyList<string>? vocabulary)
    {
        var hasContext = context is { HasText: true };
        var hasVocabulary = vocabulary is { Count: > 0 };
        if (!hasContext && !hasVocabulary) return text;
        var content = new Dictionary<string, object> { ["dictation"] = text };
        if (hasVocabulary) content["vocabulary"] = vocabulary!;
        if (hasContext) content["insertionContext"] = new
        {
            beforeText = context!.BeforeText,
            selectedText = context.SelectedText,
            afterText = context.AfterText
        };
        return JsonSerializer.Serialize(content);
    }
    private static string LoadPrompt(string resource)
    {
        using var stream = typeof(CleanupService).Assembly.GetManifestResourceStream(resource)
            ?? throw new InvalidOperationException($"The {resource} resource is missing.");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd().Trim();
    }
    private static void ValidateInsertion(string output, InsertionContext? context)
    {
        const int meaningfulContextLength = 16;
        if (context is not { HasText: true }) return;
        if (context.BeforeText.Length >= meaningfulContextLength && output.StartsWith(context.BeforeText, StringComparison.Ordinal))
            throw new InvalidDataException("AI cleanup repeated text before the cursor.");
        if (context.AfterText.Length >= meaningfulContextLength && output.EndsWith(context.AfterText, StringComparison.Ordinal))
            throw new InvalidDataException("AI cleanup repeated text after the cursor.");
    }
}
