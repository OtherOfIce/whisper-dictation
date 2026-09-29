using System.Windows.Automation;
using System.Windows.Automation.Text;

namespace LocalWhisper;

// Reads only the focused text control that receives this dictation. UIA calls stay off the UI thread.
internal static class CorrectionLearning
{
    private static readonly HashSet<string> NumberOrDateWords = new(StringComparer.OrdinalIgnoreCase)
    {
        "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
        "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
        "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety", "hundred", "thousand",
        "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
        "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"
    };
    internal sealed record Snapshot(int[] RuntimeId, nint Window, string ClassName, string AutomationId, int ControlTypeId,
        System.Windows.Rect Bounds, string Before, string Selected, string After)
    {
        public string Original => Before + Selected + After;
    }

    internal sealed record CorrectionUpdate(int Index, string? Previous, string? Term);
    private sealed record WordCorrection(int Index, string Term);

    internal sealed class Tracker
    {
        private readonly string original;
        private readonly Dictionary<int, string> emitted = new();
        private string previous;
        private long changedAt = -1;

        public Tracker(string original) { this.original = original; previous = original; }

        public CorrectionUpdate[] Observe(string edited, long activeMilliseconds)
        {
            if (edited == original && emitted.Count > 0)
            {
                previous = edited;
                changedAt = activeMilliseconds;
                var removals = emitted.Select(pair => new CorrectionUpdate(pair.Key, pair.Value, null)).ToArray();
                emitted.Clear();
                return removals;
            }
            if (edited != previous) { previous = edited; changedAt = activeMilliseconds; return []; }
            if (changedAt < 0 || activeMilliseconds - changedAt < 2500) return [];
            return Reconcile(edited);
        }

        public CorrectionUpdate[] Commit(string edited) => Reconcile(edited);

        private CorrectionUpdate[] Reconcile(string edited)
        {
            if (!TryCorrections(original, edited, out var corrections)) return [];
            var updates = new List<CorrectionUpdate>();
            var current = corrections.ToDictionary(correction => correction.Index, correction => correction.Term);
            foreach (var (index, term) in emitted.ToArray())
            {
                if (current.TryGetValue(index, out var replacement) && replacement == term) continue;
                updates.Add(new CorrectionUpdate(index, term, current.GetValueOrDefault(index)));
                emitted.Remove(index);
            }
            foreach (var correction in corrections)
                if (!emitted.ContainsKey(correction.Index))
                {
                    emitted[correction.Index] = correction.Term;
                    if (!updates.Any(update => update.Index == correction.Index))
                        updates.Add(new CorrectionUpdate(correction.Index, null, correction.Term));
                }
            return updates.ToArray();
        }
    }

    public static Task<Snapshot?> CaptureAsync(nint window, CancellationToken token, Action<string>? diagnostic = null)
    {
        var completion = new TaskCompletionSource<Snapshot?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() =>
        {
            try { completion.TrySetResult(ReadSelection(window, diagnostic)); }
            catch (Exception ex) { diagnostic?.Invoke("capture-error-" + ex.GetType().Name); completion.TrySetResult(null); }
        }) { IsBackground = true, Name = "Local Whisper correction capture" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        return completion.Task.WaitAsync(TimeSpan.FromMilliseconds(350), token);
    }

    public static void Observe(Snapshot snapshot, string pastedText, CancellationToken token, Action<CorrectionUpdate> learned, Action<string>? diagnostic = null)
    {
        var thread = new Thread(() =>
        {
            try { Watch(snapshot, pastedText, token, learned, diagnostic); }
            catch (Exception ex) { diagnostic?.Invoke("observe-error-" + ex.GetType().Name); }
        }) { IsBackground = true, Name = "Local Whisper correction observer" };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
    }

    private static Snapshot? ReadSelection(nint window, Action<string>? diagnostic)
    {
        var element = AutomationElement.FocusedElement;
        if (!Usable(element, window) || !element!.TryGetCurrentPattern(TextPattern.Pattern, out var found) || found is not TextPattern pattern)
        {
            diagnostic?.Invoke("capture-unusable");
            return null;
        }
        var selections = pattern.GetSelection();
        if (selections.Length != 1) { diagnostic?.Invoke("capture-selection-count"); return null; }
        var selection = selections[0];
        var before = pattern.DocumentRange.Clone();
        before.MoveEndpointByRange(TextPatternRangeEndpoint.End, selection, TextPatternRangeEndpoint.Start);
        var after = pattern.DocumentRange.Clone();
        after.MoveEndpointByRange(TextPatternRangeEndpoint.Start, selection, TextPatternRangeEndpoint.End);
        var left = before.GetText(4097);
        var middle = selection.GetText(4097);
        var right = after.GetText(4097);
        if (left.Length + middle.Length + right.Length > 4096) { diagnostic?.Invoke("capture-too-long"); return null; }
        diagnostic?.Invoke("capture-ready");
        return new Snapshot(element.GetRuntimeId(), window, element.Current.ClassName, element.Current.AutomationId,
            element.Current.ControlType.Id, element.Current.BoundingRectangle, left, middle, right);
    }

    private static bool Usable(AutomationElement? element, nint window)
    {
        if (element is null || element.Current.IsPassword || !element.Current.IsEnabled) return false;
        if (element.TryGetCurrentPattern(ValuePattern.Pattern, out var found) && found is ValuePattern value && value.Current.IsReadOnly) return false;
        for (var current = element; current is not null; current = TreeWalker.RawViewWalker.GetParent(current))
            if (current.Current.NativeWindowHandle == window) return true;
        return false;
    }

    private static string? ReadText(Snapshot snapshot, Action<string>? diagnostic)
    {
        if (Native.GetForegroundWindow() != snapshot.Window) { diagnostic?.Invoke("read-focus-left"); return null; }
        var element = AutomationElement.FocusedElement;
        if (!Usable(element, snapshot.Window)) { diagnostic?.Invoke("read-unusable"); return null; }
        if (!element!.GetRuntimeId().SequenceEqual(snapshot.RuntimeId))
        {
            var bounds = element.Current.BoundingRectangle;
            if (element.Current.ClassName != snapshot.ClassName || element.Current.AutomationId != snapshot.AutomationId
                || element.Current.ControlType.Id != snapshot.ControlTypeId
                || Math.Abs(bounds.X - snapshot.Bounds.X) > 48 || Math.Abs(bounds.Width - snapshot.Bounds.Width) > 80
                || Math.Abs(bounds.Bottom - snapshot.Bounds.Bottom) > 100)
            { diagnostic?.Invoke("read-id-changed"); return null; }
            diagnostic?.Invoke("read-id-reacquired");
        }
        if (!element.TryGetCurrentPattern(TextPattern.Pattern, out var found) || found is not TextPattern pattern)
        { diagnostic?.Invoke("read-no-text-pattern"); return null; }
        var text = pattern.DocumentRange.GetText(4097);
        if (text.Length > 4096) { diagnostic?.Invoke("read-too-long"); return null; }
        return text;
    }

    private static void Watch(Snapshot snapshot, string pastedText, CancellationToken token, Action<CorrectionUpdate> learned, Action<string>? diagnostic)
    {
        if (snapshot.Original.Length + pastedText.Length > 4096) { diagnostic?.Invoke("verify-too-long"); return; }
        var deadline = Environment.TickCount64 + 1200;
        var overallDeadline = Environment.TickCount64 + 30000;
        var absoluteDeadline = Environment.TickCount64 + 120000;
        string? current = null;
        string? left = null, right = null;
        while (!token.IsCancellationRequested && Environment.TickCount64 < deadline && Environment.TickCount64 < overallDeadline && Environment.TickCount64 < absoluteDeadline)
        {
            if (Native.GetForegroundWindow() != snapshot.Window) { deadline += 60; overallDeadline += 60; Thread.Sleep(60); continue; }
            current = ReadText(snapshot, diagnostic);
            if (current is null) return;
            if (TryLocatePastedText(snapshot.Original, current, pastedText, out var foundLeft, out var foundRight))
            { left = foundLeft; right = foundRight; break; }
            Thread.Sleep(60);
        }
        if (left is null || right is null) { diagnostic?.Invoke($"verify-mismatch-original-{snapshot.Original.Length}-actual-{current?.Length ?? -1}-dictated-{pastedText.Length}"); return; }
        diagnostic?.Invoke("verified");

        var pastedState = current;
        var tracker = new Tracker(pastedText);
        long activeMilliseconds = 0;
        string? lastSpan = null;
        long lastSpanChangedAt = 0;
        var reportedInvalid = false;
        while (!token.IsCancellationRequested && Environment.TickCount64 < overallDeadline && Environment.TickCount64 < absoluteDeadline)
        {
            Thread.Sleep(75);
            if (Native.GetForegroundWindow() != snapshot.Window) { overallDeadline += 75; continue; }
            activeMilliseconds += 75;
            current = ReadText(snapshot, diagnostic);
            if (current is null) return;
            if (current == pastedState)
            {
                foreach (var update in tracker.Observe(pastedText, activeMilliseconds)) learned(update);
                continue;
            }
            if (lastSpan is not null && current.Trim().Length == 0 && activeMilliseconds - lastSpanChangedAt >= 75)
            {
                foreach (var update in tracker.Commit(lastSpan)) learned(update);
                diagnostic?.Invoke("edit-committed-on-clear");
                return;
            }
            if (!TryExtractSpan(current, left, right, out var span)) { diagnostic?.Invoke("edit-outside-span"); return; }
            if (lastSpan is null) diagnostic?.Invoke("edit-detected");
            if (span != lastSpan) { lastSpan = span; lastSpanChangedAt = activeMilliseconds; reportedInvalid = false; }
            var updates = tracker.Observe(span, activeMilliseconds);
            if (updates.Length == 0)
            {
                if (!reportedInvalid && activeMilliseconds - lastSpanChangedAt >= 2500)
                { diagnostic?.Invoke("edit-no-candidate"); reportedInvalid = true; }
                continue;
            }
            diagnostic?.Invoke("candidate-ready");
            foreach (var update in updates)
                if (!token.IsCancellationRequested) learned(update);
        }
        diagnostic?.Invoke(token.IsCancellationRequested ? "observe-cancelled" : "observe-expired");
    }

    internal static bool TryLocatePastedText(string originalField, string currentField, string pastedText, out string left, out string right)
    {
        left = right = "";
        if (pastedText.Length == 0 || originalField == currentField || originalField.Contains(pastedText, StringComparison.Ordinal)) return false;
        var index = currentField.IndexOf(pastedText, StringComparison.Ordinal);
        if (index < 0 || currentField.IndexOf(pastedText, index + 1, StringComparison.Ordinal) >= 0) return false;
        left = currentField[..index]; right = currentField[(index + pastedText.Length)..];
        return true;
    }

    private static bool TryExtractSpan(string current, string left, string right, out string span)
    {
        span = "";
        if (!current.StartsWith(left, StringComparison.Ordinal)) return false;
        if (current.EndsWith(right, StringComparison.Ordinal))
        {
            span = current[left.Length..(current.Length - right.Length)];
            return true;
        }
        if (right.Length == 0 || !right.All(char.IsWhiteSpace)) return false;
        span = current[left.Length..].TrimEnd('\r', '\n');
        return true;
    }

    internal static string? Candidate(string original, string edited)
    {
        var terms = CandidateTerms(original, edited);
        return terms.Length == 1 ? terms[0] : null;
    }

    internal static string[] CandidateTerms(string original, string edited)
    {
        return TryCorrections(original, edited, out var corrections) ? corrections.Select(correction => correction.Term).ToArray() : [];
    }

    private static bool TryCorrections(string original, string edited, out WordCorrection[] corrections)
    {
        corrections = [];
        if (original.Length > 1000 || edited.Length > 1000) return false;
        var oldWords = Words(original);
        var newWords = Words(edited);
        if (oldWords.Length == 0 || oldWords.Length != newWords.Length) return false;
        var changes = new List<WordCorrection>();
        for (var i = 0; i < oldWords.Length; i++)
        {
            if (oldWords[i] == newWords[i]) continue;
            if (!PlausibleCorrection(oldWords[i], newWords[i])) return false;
            changes.Add(new WordCorrection(i, newWords[i]));
        }
        if (changes.Count > 2 || (changes.Count > 1 && oldWords.Length == changes.Count)) return false;
        corrections = changes.ToArray();
        return true;
    }

    private static string[] Words(string value)
    {
        var result = new List<string>();
        for (var i = 0; i < value.Length;)
        {
            if (!char.IsLetter(value[i])) { i++; continue; }
            var start = i++;
            while (i < value.Length && char.IsLetter(value[i])) i++;
            result.Add(value[start..i]);
        }
        return result.ToArray();
    }

    private static bool PlausibleCorrection(string before, string after)
    {
        if (before.Length is < 3 or > 50 || after.Length is < 3 or > 50) return false;
        if (!string.Equals(before, after, StringComparison.OrdinalIgnoreCase)
            && (before.StartsWith(after, StringComparison.OrdinalIgnoreCase) || before.EndsWith(after, StringComparison.OrdinalIgnoreCase)
                || after.StartsWith(before, StringComparison.OrdinalIgnoreCase) || after.EndsWith(before, StringComparison.OrdinalIgnoreCase))) return false;
        if (NumberOrDateWords.Contains(before) || NumberOrDateWords.Contains(after)) return false;
        return true;
    }
}
