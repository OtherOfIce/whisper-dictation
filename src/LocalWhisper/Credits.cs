using System.Net.Http.Headers;
using System.Text.Json;

namespace LocalWhisper;

public sealed record CreditBalance(decimal? Remaining, string Kind, string Message, DateTime Updated,
    decimal? Usage = null, decimal? UsageDaily = null, decimal? UsageMonthly = null, decimal? KeyRemaining = null);
public sealed class Credits(HttpClient http)
{
    public async Task<CreditBalance> GetAsync(string transcriptionKey, string balanceKey)
    {
        if (string.IsNullOrWhiteSpace(transcriptionKey) && string.IsNullOrWhiteSpace(balanceKey))
            return new(null, "unavailable", "Add an OpenRouter key in Settings.", DateTime.Now);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(12));
        decimal? usage = null, daily = null, monthly = null, allowance = null;
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
            }
        }
        using var request = new HttpRequestMessage(HttpMethod.Get, "https://openrouter.ai/api/v1/credits");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", string.IsNullOrWhiteSpace(balanceKey) ? transcriptionKey : balanceKey);
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
        return new(null, "unavailable", usage.HasValue ? "Usage is available from your existing key. Account balance needs an optional management key." : "Check your OpenRouter API key in Settings.", DateTime.Now, usage, daily, monthly, allowance);
    }
}
