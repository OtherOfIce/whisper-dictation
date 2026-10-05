namespace LocalWhisper;

public sealed record TranscriptionModelDefinition(string Id, string Label, string Credential,
    bool Streaming, bool DictionaryHints, int MaxDictionaryTerms, int MaxTermLength, bool ParallelRequests);

public static class TranscriptionModels
{
    public const string Gpt = "gpt-transcribe";
    public const string MaiVerbatim = "mai-transcribe-2-verbatim";
    public const string MaiClean = "mai-transcribe-2-clean";
    public const string GrokStreaming = "grok-voice-transcribe-2-streaming";
    public const string MaiStreaming = "mai-transcribe-2-streaming";
    public static IReadOnlyList<TranscriptionModelDefinition> All { get; } = Array.AsReadOnly<TranscriptionModelDefinition>([
        new(Gpt, "GPT-Transcribe", "openrouter", false, true, 1000, 12000, false),
        new(MaiVerbatim, "MAI-Transcribe-2 · Verbatim", "openrouter", false, true, 1000, 12000, true),
        new(MaiClean, "MAI-Transcribe-2 · Clean", "openrouter", false, true, 1000, 12000, true),
        new(GrokStreaming, "Grok Voice Transcribe 2.0 · Streaming", "xai", true, true, 100, 50, false),
        new(MaiStreaming, "MAI-Transcribe-2 · Streaming", "gateway", true, false, 1000, 12000, false)
    ]);
    public static bool IsValid(string value) => All.Any(model => model.Id == value);
    public static bool IsMai(string value) => value is MaiVerbatim or MaiClean;
    public static bool IsStreaming(string value) => Describe(value).Streaming;
    public static TranscriptionModelDefinition Describe(string value) => All.FirstOrDefault(model => model.Id == value)
        ?? throw new InvalidOperationException("Invalid transcription model.");
    internal static void ValidateDictionary(string model, IReadOnlyList<string> dictionary)
    {
        var definition = Describe(model);
        if (definition.DictionaryHints && (dictionary.Count > definition.MaxDictionaryTerms
            || dictionary.Any(term => term.Length > definition.MaxTermLength)))
            throw new InvalidOperationException($"{definition.Label} accepts up to {definition.MaxDictionaryTerms} dictionary terms of {definition.MaxTermLength} characters each.");
    }
}
