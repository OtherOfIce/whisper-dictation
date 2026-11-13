using System.Text.Json;
using LocalWhisper;

internal static class StabilityChecks
{
    internal static void Run(Action<bool, string> check)
    {
        check(EngineApp.TranscriptionDeadline(0) == TimeSpan.FromSeconds(15), "Short recordings keep the 15 second transcription deadline");
        check(EngineApp.TranscriptionDeadline(60) == TimeSpan.FromSeconds(45), "Transcription deadline grows with recording length");
        check(EngineApp.TranscriptionDeadline(300) == TimeSpan.FromSeconds(120) && EngineApp.TranscriptionDeadline(-5) == TimeSpan.FromSeconds(15),
            "Transcription deadline stays within its bounds");

        int Id(string json) => EngineApp.RequestId(JsonSerializer.Deserialize<JsonElement>(json));
        check(Id("{\"id\":7,\"method\":\"state\"}") == 7, "A command id is read");
        check(Id("{\"id\":\"7\"}") == 0 && Id("{\"id\":1.5}") == 0 && Id("{\"id\":99999999999}") == 0 && Id("[1]") == 0 && Id("\"x\"") == 0 && Id("{}") == 0,
            "Malformed command ids are treated as unknown instead of throwing");

        var folder = Path.Combine(Path.GetTempPath(), "LocalWhisper.Tests." + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        try
        {
            var file = Path.Combine(folder, "muted-devices.txt");
            var unmuted = new List<string>();
            DictationAudio.RecoverMuted(file, unmuted.Add);
            check(unmuted.Count == 0, "No muted-device record means nothing is unmuted at startup");
            File.WriteAllLines(file, ["{gone}", "{speakers}", ""]);
            DictationAudio.RecoverMuted(file, id => { if (id == "{gone}") throw new InvalidOperationException("Device removed"); unmuted.Add(id); });
            check(unmuted.SequenceEqual(["{speakers}"]) && !File.Exists(file), "Devices left muted by a crash are unmuted once at startup, even if one is gone");
        }
        finally { Directory.Delete(folder, true); }

        IDataObject data = Paste.Private(new DataObject(DataFormats.UnicodeText, "secret dictation"));
        check((string?)data.GetData(DataFormats.UnicodeText) == "secret dictation", "Private clipboard data keeps the dictated text");
        check(new[] { "ExcludeClipboardContentFromMonitorProcessing", "CanIncludeInClipboardHistory", "CanUploadToCloudClipboard" }
            .All(format => data.GetData(format) is MemoryStream stream && stream.ToArray().SequenceEqual(new byte[4])),
            "Dictated text is excluded from clipboard history and cloud clipboard");
    }
}
