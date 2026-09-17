namespace LocalWhisper;

internal static class InsertionFitter
{
    public static string Fit(string text, InsertionContext? context)
    {
        if (context is not { HasText: true } || text.Length == 0) return text;

        var fitted = RemoveConflictingTerminalPunctuation(text, context.AfterText);
        var selectedLetter = FirstLetter(context.SelectedText);
        if (selectedLetter is not null)
            return MatchFirstLetterCase(fitted, char.IsUpper(selectedLetter.Value));

        var before = context.BeforeText.TrimEnd();
        if (before.Length == 0 || before[^1] is '.' or '!' or '?')
            return MatchFirstLetterCase(fitted, uppercase: true);

        return fitted;
    }

    private static string RemoveConflictingTerminalPunctuation(string text, string afterText)
    {
        var after = afterText.TrimStart();
        if (after.Length == 0 || !IsJoinPunctuation(after[0])) return text;

        var end = text.Length;
        while (end > 0 && IsJoinPunctuation(text[end - 1])) end--;
        return end == text.Length ? text : text[..end].TrimEnd();
    }

    private static string MatchFirstLetterCase(string text, bool uppercase)
    {
        for (var index = 0; index < text.Length; index++)
        {
            if (!char.IsLetter(text[index])) continue;
            var replacement = uppercase ? char.ToUpperInvariant(text[index]) : char.ToLowerInvariant(text[index]);
            return replacement == text[index] ? text : text[..index] + replacement + text[(index + 1)..];
        }
        return text;
    }

    private static char? FirstLetter(string text)
    {
        foreach (var character in text)
            if (char.IsLetter(character)) return character;
        return null;
    }

    private static bool IsJoinPunctuation(char character) => character is '.' or ',' or '!' or '?' or ':' or ';';
}
