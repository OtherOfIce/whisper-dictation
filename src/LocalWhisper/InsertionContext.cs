namespace LocalWhisper;

internal sealed record InsertionContext(string BeforeText, string SelectedText, string AfterText)
{
    public const int MaximumCharactersPerSide = 500;
    public static readonly InsertionContext Empty = new("", "", "");
    public bool HasText => BeforeText.Length > 0 || SelectedText.Length > 0 || AfterText.Length > 0;
}
