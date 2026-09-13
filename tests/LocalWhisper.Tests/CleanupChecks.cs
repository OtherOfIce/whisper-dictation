using System.Net;
using System.Text.Json;
using LocalWhisper;

internal static class CleanupChecks
{
    public static async Task RunAsync(Action<bool, string> check)
    {
        foreach (var tier in new[] { CleanupServiceTier.Standard, CleanupServiceTier.Fast })
        {
            using var http = new HttpClient(new Handler(async (request, cancellation) =>
            {
                check(request.RequestUri!.ToString() == "https://openrouter.ai/api/v1/chat/completions", "Cleanup uses the chat completions endpoint");
                check(request.Headers.Authorization?.Parameter == "test-only", "Cleanup sends the OpenRouter key as a bearer token");
                using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellation));
                var root = body.RootElement;
                check(root.GetProperty("model").GetString() == CleanupService.Model, "Cleanup uses the Luna model");
                check(root.GetProperty("service_tier").GetString() == (tier == CleanupServiceTier.Fast ? "priority" : "default"), "Cleanup selects the requested service tier");
                check(root.GetProperty("reasoning_effort").GetString() == "none", "Cleanup disables reasoning for latency");
                check(root.GetProperty("max_completion_tokens").GetInt32() == CleanupService.OutputTokenBudget("um hello"), "Cleanup sends its calculated output budget");
                check(root.GetProperty("messages")[1].GetProperty("content").GetString() == "um hello", "Cleanup sends the raw transcript unchanged");
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent("{\"model\":\"openai/gpt-5.6-luna\",\"service_tier\":\"priority\",\"choices\":[{\"message\":{\"content\":\"Hello.\"}}],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":2,\"cost\":0.00001,\"completion_tokens_details\":{\"reasoning_tokens\":0}}}")
                };
            }));
            var result = await new CleanupService(http).CleanupAsync("um hello", "test-only", tier, default);
            check(result.Text == "Hello." && result.InputTokens == 12 && result.OutputTokens == 2, "Cleanup parses text and token usage");
            check(result.Cost == 0.00001m && result.ServiceTier == "priority", "Cleanup exposes cost and actual service tier for evaluation");
        }
        check(CleanupService.OutputTokenBudget(new string('a', 12000)) > CleanupService.OutputTokenBudget("short"), "Long dictation receives a larger output budget");
        check(CleanupService.OutputTokenBudget(new string('界', 12000)) == 16384, "Output budget is bounded for long multilingual dictation");

        using var malformed = new HttpClient(new Handler((_, _) => Task.FromResult(
            new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"choices\":[]}") })));
        try
        {
            await new CleanupService(malformed).CleanAsync("keep me", "test-only", CleanupService.Luna, default);
            throw new Exception("Expected missing cleanup text to fail");
        }
        catch (InvalidDataException) { check(true, "Cleanup rejects a response without text so the engine can use raw text"); }

        foreach (var stopReason in new[] { "\"finish_reason\":\"length\"", "\"native_finish_reason\":\"max_tokens\"" })
        {
            using var truncated = new HttpClient(new Handler((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent($"{{\"choices\":[{{{stopReason},\"message\":{{\"content\":\"partial\"}}}}]}}")
            })));
            try
            {
                await new CleanupService(truncated).CleanAsync("keep all of me", "test-only", CleanupService.Luna, default);
                throw new Exception("Expected truncated cleanup to fail");
            }
            catch (InvalidDataException) { check(true, "Cleanup rejects a length-truncated response so the engine can use raw text"); }
        }

        using var cancellation = new CancellationTokenSource();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var blocked = new HttpClient(new Handler(async (_, token) =>
        {
            started.SetResult();
            await Task.Delay(Timeout.Infinite, token);
            return new HttpResponseMessage(HttpStatusCode.OK);
        }));
        var pending = new CleanupService(blocked).CleanAsync("keep me", "test-only", CleanupService.Luna, cancellation.Token);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(3));
        cancellation.Cancel();
        try
        {
            await pending;
            throw new Exception("Expected cleanup cancellation");
        }
        catch (OperationCanceledException) { check(true, "Cleanup preserves in-flight user cancellation"); }
    }
}
