using LocalWhisper;

internal static class DictationAudioChecks
{
    public static async Task RunAsync(Action<bool, string> check)
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finishPause = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var events = new List<string>();
        var first = new DictationAudio(async () =>
        {
            events.Add("pause first");
            entered.SetResult();
            await finishPause.Task;
        }, () => { events.Add("restore first"); return Task.CompletedTask; });
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var firstRelease = first.RestoreAsync();
        var secondEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var second = new DictationAudio(() =>
        {
            events.Add("pause second"); secondEntered.SetResult(); return Task.CompletedTask;
        }, () => { events.Add("restore second"); return Task.CompletedTask; });
        check(!firstRelease.IsCompleted && !secondEntered.Task.IsCompleted,
            "Cancellation waits for an in-flight pause before restoring or interrupting another session");
        finishPause.SetResult();
        await firstRelease.WaitAsync(TimeSpan.FromSeconds(5));
        await secondEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await second.RestoreAsync().WaitAsync(TimeSpan.FromSeconds(5));
        await second.RestoreAsync();
        check(events.SequenceEqual(new[] { "pause first", "restore first", "pause second", "restore second" }),
            "Rapid restart restores the earlier session first and repeated restoration is harmless");

        var failedEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var restored = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var failed = new DictationAudio(() =>
        {
            failedEntered.SetResult(); throw new InvalidOperationException("Player closed after muting");
        }, () => { restored.SetResult(); return Task.CompletedTask; });
        await failedEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await failed.RestoreAsync().WaitAsync(TimeSpan.FromSeconds(5));
        check(restored.Task.IsCompletedSuccessfully, "A partial interruption failure still restores audio");

        var shutdownEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var shutdownRestored = false;
        _ = new DictationAudio(() => { shutdownEntered.SetResult(); return Task.CompletedTask; },
            () => { shutdownRestored = true; return Task.CompletedTask; });
        await shutdownEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await DictationAudio.RestoreAllAsync().WaitAsync(TimeSpan.FromSeconds(5));
        check(shutdownRestored, "Shutdown releases active audio control");
    }
}
