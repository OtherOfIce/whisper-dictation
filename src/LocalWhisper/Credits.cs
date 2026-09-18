using System.Net.Http.Headers;
using System.Text.Json;

namespace LocalWhisper;

public sealed record CreditBalance(decimal? Remaining, string Kind, string Message, DateTime Updated,
    decimal? Usage = null, decimal? UsageDaily = null, decimal? UsageMonthly = null, decimal? KeyRemaining = null);
public sealed record ActivityCostRow(string Date, string Category, string Model, string Provider, string Endpoint,
    decimal Amount, long Requests);
public sealed record ActivityImport(ActivityCostRow[] Rows, DateTime Through, DateTime ImportedAt);

public sealed class Credits(HttpClient http)
{
    public async Task<CreditBalance> GetAsync(string transcriptionKey)
    {
        if (string.IsNullOrWhiteSpace(transcriptionKey))
            return new(null, "unavailable", "Add an OpenRouter key in Settings.", DateTime.Now);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(12));
        decimal? usage = null, daily = null, monthly = null, allowance = null;
        using (var keyRequest = Request("https://openrouter.ai/api/v1/key", transcriptionKey))
        using (var keyResponse = await http.SendAsync(keyRequest, timeout.Token).ConfigureAwait(false))
        {
            if (keyResponse.IsSuccessStatusCode)
            {
                using var doc = JsonDocument.Parse(await keyResponse.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false));
                var data = doc.RootElement.GetProperty("data");
                usage = Number(data, "usage"); daily = Number(data, "usage_daily"); monthly = Number(data, "usage_monthly"); allowance = Number(data, "limit_remaining");
            }
        }
        using var request = Request("https://openrouter.ai/api/v1/credits", transcriptionKey);
        using var response = await http.SendAsync(request, timeout.Token).ConfigureAwait(false);
        if (response.IsSuccessStatusCode)
        {
            using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false));
            var data = doc.RootElement.GetProperty("data");
            return new(data.GetProperty("total_credits").GetDecimal() - data.GetProperty("total_usage").GetDecimal(), "account", "OpenRouter account balance", DateTime.Now, usage, daily, monthly, allowance);
        }
        if (response.StatusCode is not (System.Net.HttpStatusCode.Forbidden or System.Net.HttpStatusCode.Unauthorized))
            return new(null, "unavailable", "Balance unavailable. Try refreshing shortly.", DateTime.Now, usage, daily, monthly, allowance);
        if (allowance.HasValue) return new(allowance, "key", "API key allowance, not your account balance", DateTime.Now, usage, daily, monthly, allowance);
        return new(null, "unavailable", usage.HasValue ? "Usage is available from your existing key." : "Check your OpenRouter API key in Settings.", DateTime.Now, usage, daily, monthly, allowance);
    }

    public async Task<ActivityImport> ImportActivityAsync(string transcriptionKey, string managementKey, CancellationToken cancellation = default)
    {
        if (string.IsNullOrWhiteSpace(transcriptionKey)) throw new InvalidOperationException("Add your OpenRouter API key before importing costs.");
        if (string.IsNullOrWhiteSpace(managementKey)) throw new InvalidOperationException("Enter a temporary OpenRouter management key.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(TimeSpan.FromSeconds(25));

        string? keyHash;
        string? keyLabel;
        using (var keyRequest = Request("https://openrouter.ai/api/v1/key", transcriptionKey))
        using (var keyResponse = await http.SendAsync(keyRequest, timeout.Token).ConfigureAwait(false))
        {
            if (!keyResponse.IsSuccessStatusCode) throw new InvalidOperationException("The saved OpenRouter API key could not be read.");
            using var key = JsonDocument.Parse(await keyResponse.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false));
            var data = key.RootElement.GetProperty("data");
            keyHash = String(data, "hash");
            keyLabel = String(data, "label");
        }

        if (string.IsNullOrWhiteSpace(keyHash)) keyHash = await ResolveKeyHashAsync(managementKey, keyLabel, timeout.Token).ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(keyHash)) throw new InvalidOperationException("The saved API key was not found in this OpenRouter account.");

        using var activityRequest = Request($"https://openrouter.ai/api/v1/activity?api_key_hash={Uri.EscapeDataString(keyHash)}", managementKey);
        using var activityResponse = await http.SendAsync(activityRequest, timeout.Token).ConfigureAwait(false);
        if (activityResponse.StatusCode is System.Net.HttpStatusCode.Forbidden or System.Net.HttpStatusCode.Unauthorized)
            throw new InvalidOperationException("OpenRouter rejected the management key.");
        if (!activityResponse.IsSuccessStatusCode) throw new InvalidOperationException("OpenRouter activity could not be imported. Try again shortly.");
        using var activity = JsonDocument.Parse(await activityResponse.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false));
        var grouped = new Dictionary<(string Date, string Category, string Model, string Provider, string Endpoint), (decimal Amount, long Requests)>();
        foreach (var item in activity.RootElement.GetProperty("data").EnumerateArray())
        {
            var date = String(item, "date");
            var model = String(item, "model");
            var amount = Number(item, "usage");
            var category = Category(model);
            if (date is null || model is null || amount is null || amount < 0 || category is null) continue;
            var groupKey = (date, category, model, String(item, "provider_name") ?? "", String(item, "endpoint_id") ?? "");
            var current = grouped.GetValueOrDefault(groupKey);
            grouped[groupKey] = (current.Amount + amount.Value, current.Requests + Integer(item, "requests"));
        }
        var rows = grouped.Select(row => new ActivityCostRow(row.Key.Date, row.Key.Category, row.Key.Model,
            row.Key.Provider, row.Key.Endpoint, row.Value.Amount, row.Value.Requests)).ToArray();
        return new(rows, DateTime.UtcNow.Date.AddDays(-1), DateTime.UtcNow);
    }

    private async Task<string?> ResolveKeyHashAsync(string managementKey, string? keyLabel, CancellationToken cancellation)
    {
        if (string.IsNullOrWhiteSpace(keyLabel)) return null;
        using var request = Request("https://openrouter.ai/api/v1/keys?include_disabled=true", managementKey);
        using var response = await http.SendAsync(request, cancellation).ConfigureAwait(false);
        if (response.StatusCode is System.Net.HttpStatusCode.Forbidden or System.Net.HttpStatusCode.Unauthorized)
            throw new InvalidOperationException("OpenRouter rejected the management key.");
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException("OpenRouter API keys could not be read.");
        using var keys = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellation).ConfigureAwait(false));
        var match = keys.RootElement.GetProperty("data").EnumerateArray().FirstOrDefault(item => String(item, "label") == keyLabel);
        return String(match, "hash");
    }

    private static string? Category(string? model) => model switch
    {
        Transcriber.Model or Transcriber.MaiModel => "voice",
        CleanupService.Model => "cleanup",
        _ => null
    };
    private static HttpRequestMessage Request(string uri, string key)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, uri);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        return request;
    }
    private static decimal? Number(JsonElement data, string name) =>
        data.ValueKind == JsonValueKind.Object && data.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number ? value.GetDecimal() : null;
    private static long Integer(JsonElement data, string name) =>
        data.ValueKind == JsonValueKind.Object && data.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var result) ? result : 0;
    private static string? String(JsonElement data, string name) =>
        data.ValueKind == JsonValueKind.Object && data.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}
