using System.Net.Http.Headers;
using System.Text.Json;

namespace LocalWhisper;

public sealed record CreditBalance(decimal? Remaining, string Kind, string Message, DateTime Updated,
    decimal? Usage = null, decimal? UsageDaily = null, decimal? UsageMonthly = null, decimal? KeyRemaining = null,
    CostRow[]? Costs = null, DateTime? CostsThrough = null);
public sealed class Credits(HttpClient http)
{
    public async Task<CreditBalance> GetAsync(string transcriptionKey, string balanceKey)
    {
        if (string.IsNullOrWhiteSpace(transcriptionKey) && string.IsNullOrWhiteSpace(balanceKey))
            return new(null, "unavailable", "Add an OpenRouter key in Settings.", DateTime.Now);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(12));
        decimal? usage = null, daily = null, monthly = null, allowance = null;
        string? keyLabel = null, keyHash = null;
        if (!string.IsNullOrWhiteSpace(transcriptionKey))
        {
            using var keyRequest = new HttpRequestMessage(HttpMethod.Get, "https://openrouter.ai/api/v1/key");
            keyRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", transcriptionKey);
            using var keyResponse = await http.SendAsync(keyRequest, timeout.Token).ConfigureAwait(false);
            if (keyResponse.IsSuccessStatusCode)
            {
                using var doc = JsonDocument.Parse(await keyResponse.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false));
                var data = doc.RootElement.GetProperty("data");
                static decimal? Number(JsonElement d, string name) => d.TryGetProperty(name, out var n) && n.ValueKind == JsonValueKind.Number ? n.GetDecimal() : null;
                usage = Number(data, "usage"); daily = Number(data, "usage_daily"); monthly = Number(data, "usage_monthly"); allowance = Number(data, "limit_remaining");
                keyLabel = String(data, "label"); keyHash = String(data, "hash");
            }
        }
        var costsTask = string.IsNullOrWhiteSpace(balanceKey)
            ? Task.FromResult<CostRow[]?>(null)
            : TryActivityAsync(balanceKey, keyLabel, keyHash, timeout.Token);
        using var request = new HttpRequestMessage(HttpMethod.Get, "https://openrouter.ai/api/v1/credits");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", string.IsNullOrWhiteSpace(balanceKey) ? transcriptionKey : balanceKey);
        using var response = await http.SendAsync(request, timeout.Token).ConfigureAwait(false);
        var costs = await costsTask.ConfigureAwait(false);
        if (response.IsSuccessStatusCode)
        {
            using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false));
            var data = doc.RootElement.GetProperty("data");
            return new(data.GetProperty("total_credits").GetDecimal() - data.GetProperty("total_usage").GetDecimal(), "account", "OpenRouter account balance", DateTime.Now, usage, daily, monthly, allowance, costs, costs is null ? null : DateTime.UtcNow.Date.AddDays(-1));
        }
        if (response.StatusCode is not (System.Net.HttpStatusCode.Forbidden or System.Net.HttpStatusCode.Unauthorized))
            return new(null, "unavailable", "Balance unavailable. Try refreshing shortly.", DateTime.Now, usage, daily, monthly, allowance);
        if (allowance.HasValue) return new(allowance, "key", "API key allowance, not your account balance", DateTime.Now, usage, daily, monthly, allowance);
        return new(null, "unavailable", usage.HasValue ? "Usage is available from your existing key. Account balance needs an optional management key." : "Check your OpenRouter API key in Settings.", DateTime.Now, usage, daily, monthly, allowance);
    }

    private async Task<CostRow[]?> TryActivityAsync(string managementKey, string? keyLabel, string? keyHash, CancellationToken cancellation)
    {
        try { return await ActivityAsync(managementKey, keyLabel, keyHash, cancellation).ConfigureAwait(false); }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or InvalidOperationException or KeyNotFoundException or TaskCanceledException) { return null; }
    }

    private async Task<CostRow[]?> ActivityAsync(string managementKey, string? keyLabel, string? keyHash, CancellationToken cancellation)
    {
        if (string.IsNullOrWhiteSpace(keyHash) && !string.IsNullOrWhiteSpace(keyLabel))
        {
            using var keysRequest = Request("https://openrouter.ai/api/v1/keys?include_disabled=true", managementKey);
            using var keysResponse = await http.SendAsync(keysRequest, cancellation).ConfigureAwait(false);
            if (!keysResponse.IsSuccessStatusCode) return null;
            using var keys = JsonDocument.Parse(await keysResponse.Content.ReadAsStringAsync(cancellation).ConfigureAwait(false));
            var match = keys.RootElement.GetProperty("data").EnumerateArray().FirstOrDefault(item => String(item, "label") == keyLabel);
            keyHash = String(match, "hash");
        }
        if (string.IsNullOrWhiteSpace(keyHash)) return null;
        using var activityRequest = Request($"https://openrouter.ai/api/v1/activity?api_key_hash={Uri.EscapeDataString(keyHash)}", managementKey);
        using var activityResponse = await http.SendAsync(activityRequest, cancellation).ConfigureAwait(false);
        if (!activityResponse.IsSuccessStatusCode) return null;
        using var activity = JsonDocument.Parse(await activityResponse.Content.ReadAsStringAsync(cancellation).ConfigureAwait(false));
        var costs = new List<CostRow>();
        foreach (var item in activity.RootElement.GetProperty("data").EnumerateArray())
        {
            var model = String(item, "model");
            var amount = Number(item, "usage");
            var category = model is Transcriber.Model or Transcriber.MaiModel ? "voice" : model == CleanupService.Model ? "cleanup" : null;
            if (category is not null && model is not null && amount is not null) costs.Add(new(category, model, amount.Value));
        }
        return costs.ToArray();
    }

    private static HttpRequestMessage Request(string uri, string key)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, uri);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        return request;
    }
    private static decimal? Number(JsonElement data, string name) =>
        data.ValueKind == JsonValueKind.Object && data.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number ? value.GetDecimal() : null;
    private static string? String(JsonElement data, string name) =>
        data.ValueKind == JsonValueKind.Object && data.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}
