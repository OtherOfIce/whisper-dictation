using System.Net;
using System.Text;
using System.Text.Json;
using LocalWhisper;

internal static class VocabularyChecks
{
    public static async Task RunAsync(Action<bool, string> check)
    {
        var terms = Vocabulary.Normalize([" Astra ", "", "astra", "Sea of Storms", "雷影"]);
        check(terms.SequenceEqual(new[] { "Astra", "Sea of Storms", "雷影" }), "Dictionary trims blanks, deduplicates, and keeps phrases and Unicode");
        foreach (var invalid in new[] { new[] { new string('a', 121) }, new[] { "two\nlines" }, Enumerable.Range(0, 1001).Select(i => i.ToString()).ToArray(), Enumerable.Range(0, 110).Select(i => new string('a', 115) + i).ToArray() })
        {
            try { Vocabulary.Normalize(invalid); throw new Exception("Expected dictionary validation failure"); }
            catch (InvalidOperationException) { check(true, "Dictionary rejects oversized or multiline entries"); }
        }
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + "-vocabulary.bin");
        try
        {
            check(Vocabulary.Load(path).Length == 0, "Missing dictionary starts empty");
            Vocabulary.Save(path, terms);
            check(Vocabulary.Load(path).SequenceEqual(terms), "Encrypted dictionary survives reload");
            check(!Encoding.UTF8.GetString(File.ReadAllBytes(path)).Contains("Astra"), "Dictionary is not stored as plaintext");
            Vocabulary.Save(path, []);
            check(Vocabulary.Load(path).Length == 0, "Clearing dictionary persists");
        }
        finally { File.Delete(path); File.Delete(path + ".tmp"); }
        foreach (var enabled in new[] { false, true })
        {
            using var http = new HttpClient(new Handler(async (request, token) =>
            {
                using var json = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
                var root = json.RootElement;
                check(root.TryGetProperty("provider", out _) == enabled, "Empty dictionary leaves transcription request unchanged");
                if (enabled)
                {
                    var keywords = root.GetProperty("provider").GetProperty("options").GetProperty("openai").GetProperty("keywords");
                    check(keywords.EnumerateArray().Select(x => x.GetString()).SequenceEqual(terms), "Transcription sends the full dictionary at the verified provider path");
                }
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"text\":\"Astra\"}") };
            }));
            check(await new Transcriber(http).TranscribeAsync([1, 2], "test-only", default, dictionaryTerms: enabled ? terms : [], transcriptionModel: TranscriptionModels.Gpt) == "Astra", "GPT dictionary requests preserve transcription response behavior");
        }
        foreach (var model in new[] { TranscriptionModels.MaiVerbatim, TranscriptionModels.MaiClean })
        {
            using var http = new HttpClient(new Handler(async (request, token) =>
            {
                using var json = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
                var root = json.RootElement;
                check(root.GetProperty("model").GetString() == Transcriber.MaiModel, "MAI choices use the MAI model ID");
                var azure = root.GetProperty("provider").GetProperty("options").GetProperty("azure");
                var style = azure.GetProperty("enhancedMode").GetProperty("modelOptions").GetProperty("transcribeStyle").GetString();
                check(style == (model == TranscriptionModels.MaiClean ? "clean" : "verbatim"), "MAI choices send the selected transcription style");
                var phrases = azure.GetProperty("phraseList").GetProperty("phrases").EnumerateArray().Select(x => x.GetString());
                check(phrases.SequenceEqual(terms), "MAI sends dictionary terms through Azure phrase hints");
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"text\":\"Astra\"}") };
            }));
            check(await new Transcriber(http).TranscribeAsync([1, 2], "test-only", default, dictionaryTerms: terms, transcriptionModel: model) == "Astra", "MAI requests preserve transcription response behavior");
        }
    }
}
