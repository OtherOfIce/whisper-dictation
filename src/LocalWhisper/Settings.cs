using System.Security.Cryptography;
using System.Text;

namespace LocalWhisper;

internal static class Settings
{
    private static readonly string Folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LocalWhisper");
    private static readonly string KeyFile = Path.Combine(Folder, "key.bin");
    private static readonly string XaiKeyFile = Path.Combine(Folder, "xai-key.bin");
    private static readonly string DictionaryFile = Path.Combine(Folder, "dictionary.bin");
    public static string[] LoadDictionaryTerms() => Vocabulary.Load(DictionaryFile);
    public static void SaveDictionaryTerms(string[] terms) => Vocabulary.Save(DictionaryFile, terms);
    public static void RemoveLegacyBalanceKey()
    {
        var file = Path.Combine(Folder, "balance-key.bin");
        if (File.Exists(file)) File.Delete(file);
        if (File.Exists(file + ".tmp")) File.Delete(file + ".tmp");
    }
    private static readonly string LiveFile = Path.Combine(Folder, "live-chunks.txt");
    public static bool LiveChunks => File.Exists(LiveFile) && File.ReadAllText(LiveFile).Trim() == "true";
    public static void SaveLiveChunks(bool enabled) { Directory.CreateDirectory(Folder); File.WriteAllText(LiveFile, enabled ? "true" : "false"); }
    private static readonly string DoubleFile = Path.Combine(Folder, "double-transcription.txt");
    public static bool DoubleTranscription => !File.Exists(DoubleFile) || File.ReadAllText(DoubleFile).Trim() == "true";
    public static void SaveDoubleTranscription(bool enabled) { Directory.CreateDirectory(Folder); File.WriteAllText(DoubleFile, enabled ? "true" : "false"); }
    private static readonly string LockModeFile = Path.Combine(Folder, "lock-mode.txt");
    public static bool LockMode => !File.Exists(LockModeFile) || File.ReadAllText(LockModeFile).Trim() == "true";
    public static void SaveLockMode(bool enabled) { Directory.CreateDirectory(Folder); File.WriteAllText(LockModeFile, enabled ? "true" : "false"); }
    private static readonly string CleanupFile = Path.Combine(Folder, "cleanup-mode.txt");
    private static readonly string TranscriptionModelFile = Path.Combine(Folder, "transcription-model.txt");
    public static string TranscriptionModel
    {
        get
        {
            var model = File.Exists(TranscriptionModelFile) ? File.ReadAllText(TranscriptionModelFile).Trim() : TranscriptionModels.MaiClean;
            return TranscriptionModels.IsValid(model) ? model : TranscriptionModels.MaiClean;
        }
    }
    public static void SaveTranscriptionModel(string model)
    {
        if (!TranscriptionModels.IsValid(model)) throw new InvalidOperationException("Invalid transcription model.");
        Directory.CreateDirectory(Folder);
        File.WriteAllText(TranscriptionModelFile + ".tmp", model);
        File.Move(TranscriptionModelFile + ".tmp", TranscriptionModelFile, true);
    }
    public static string CleanupMode
    {
        get
        {
            var mode = File.Exists(CleanupFile) ? File.ReadAllText(CleanupFile).Trim() : CleanupService.Off;
            return CleanupService.IsMode(mode) ? mode : CleanupService.Off;
        }
    }
    public static void SaveCleanupMode(string mode)
    {
        if (!CleanupService.IsMode(mode)) throw new InvalidOperationException("Invalid cleanup mode.");
        Directory.CreateDirectory(Folder);
        File.WriteAllText(CleanupFile + ".tmp", mode);
        File.Move(CleanupFile + ".tmp", CleanupFile, true);
    }
    public static string LoadKey()
    {
        if (File.Exists(KeyFile))
            return Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(KeyFile), null, DataProtectionScope.CurrentUser));
        return Environment.GetEnvironmentVariable("OPENROUTER_API_KEY") ?? "";
    }
    public static void SaveKey(string key)
        => SaveProtected(KeyFile, key);
    public static string LoadXaiKey()
    {
        if (File.Exists(XaiKeyFile)) return LoadProtected(XaiKeyFile);
        return Environment.GetEnvironmentVariable("XAI_API_KEY") ?? "";
    }
    public static void SaveXaiKey(string key) => SaveProtected(XaiKeyFile, key);
    private static string LoadProtected(string path) =>
        Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(path), null, DataProtectionScope.CurrentUser));
    private static void SaveProtected(string path, string key)
    {
        Directory.CreateDirectory(Folder);
        var encrypted = ProtectedData.Protect(Encoding.UTF8.GetBytes(key), null, DataProtectionScope.CurrentUser);
        File.WriteAllBytes(path + ".tmp", encrypted);
        File.Move(path + ".tmp", path, true);
    }
}
