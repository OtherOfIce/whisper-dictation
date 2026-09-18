using System.Windows.Automation;
using System.Windows.Automation.Text;

namespace LocalWhisper;

internal static class TargetContext
{
    private static readonly TimeSpan CaptureTimeout = TimeSpan.FromMilliseconds(750);
    private static readonly TimeSpan TargetCheckTimeout = TimeSpan.FromMilliseconds(300);

    /// <summary>
    ///  Whether the focused element looks like a text target inside <paramref name="targetWindow"/>.
    ///  True allows paste, false refuses it, null means the check was inconclusive so the caller
    ///  should fail open and paste anyway. Never throws for UI Automation failures; only an
    ///  explicitly cancelled <paramref name="cancellation"/> propagates.
    /// </summary>
    public static async Task<bool?> AcceptsTextAsync(nint targetWindow, CancellationToken cancellation)
    {
        cancellation.ThrowIfCancellationRequested();
        if (targetWindow == 0) return null;
        var completion = new TaskCompletionSource<bool?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() =>
        {
            try { completion.TrySetResult(AcceptsText(AutomationElement.FocusedElement, targetWindow)); }
            catch { completion.TrySetResult(null); }
        }) { IsBackground = true, Name = "Local Whisper paste-target check" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(TargetCheckTimeout);
        try { return await completion.Task.WaitAsync(timeout.Token).ConfigureAwait(false); }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested) { return null; }
    }

    private static bool? AcceptsText(AutomationElement? focused, nint targetWindow)
    {
        try
        {
            if (focused is null) return false;
            if (focused.Current.IsPassword) return true;
            if (!BelongsToWindow(focused, targetWindow)) return null;
            if (focused.TryGetCurrentPattern(TextPattern.Pattern, out _)) return true;
            if (focused.TryGetCurrentPattern(ValuePattern.Pattern, out var value) && value is ValuePattern text && !text.Current.IsReadOnly) return true;
            return false;
        }
        catch { return null; }
    }

    public static async Task<InsertionContext> CaptureAsync(nint targetWindow, CancellationToken cancellation)
    {
        if (targetWindow == 0) return InsertionContext.Empty;
        var completion = new TaskCompletionSource<InsertionContext>(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() =>
        {
            try { completion.TrySetResult(Capture(targetWindow)); }
            catch { completion.TrySetResult(InsertionContext.Empty); }
        }) { IsBackground = true, Name = "Local Whisper context capture" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        timeout.CancelAfter(CaptureTimeout);
        try { return await completion.Task.WaitAsync(timeout.Token).ConfigureAwait(false); }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested) { return InsertionContext.Empty; }
    }

    private static InsertionContext Capture(nint targetWindow)
    {
        var focused = AutomationElement.FocusedElement;
        if (focused is null || focused.Current.IsPassword || !BelongsToWindow(focused, targetWindow))
            return InsertionContext.Empty;
        if (!focused.TryGetCurrentPattern(TextPattern.Pattern, out var value) || value is not TextPattern pattern)
            return InsertionContext.Empty;
        var selections = pattern.GetSelection();
        if (selections.Length != 1) return InsertionContext.Empty;

        var selection = selections[0];
        var before = selection.Clone();
        before.MoveEndpointByRange(TextPatternRangeEndpoint.End, selection, TextPatternRangeEndpoint.Start);
        before.MoveEndpointByUnit(TextPatternRangeEndpoint.Start, TextUnit.Character, -InsertionContext.MaximumCharactersPerSide);

        var after = selection.Clone();
        after.MoveEndpointByRange(TextPatternRangeEndpoint.Start, selection, TextPatternRangeEndpoint.End);
        after.MoveEndpointByUnit(TextPatternRangeEndpoint.End, TextUnit.Character, InsertionContext.MaximumCharactersPerSide);

        return new InsertionContext(
            before.GetText(InsertionContext.MaximumCharactersPerSide),
            selection.GetText(InsertionContext.MaximumCharactersPerSide),
            after.GetText(InsertionContext.MaximumCharactersPerSide));
    }

    private static bool BelongsToWindow(AutomationElement element, nint targetWindow)
    {
        for (var current = element; current is not null; current = TreeWalker.RawViewWalker.GetParent(current))
            if (current.Current.NativeWindowHandle == targetWindow) return true;
        return false;
    }
}
