using System.Security.Cryptography;
using System.Text;

namespace LocalWhisper;

internal static class Settings
{
    private static readonly string Folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LocalWhisper");
    private static readonly string KeyFile = Path.Combine(Folder, "key.bin");
    private static readonly string DictionaryFile = Path.Combine(Folder, "dictionary.bin");
    public static string[] LoadDictionaryTerms() => Vocabulary.Load(DictionaryFile);
    public static void SaveDictionaryTerms(string[] terms) => Vocabulary.Save(DictionaryFile, terms);
    private static readonly string BalanceKeyFile = Path.Combine(Folder, "balance-key.bin");
    public static string LoadBalanceKey() => File.Exists(BalanceKeyFile) ? Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(BalanceKeyFile), null, DataProtectionScope.CurrentUser)) : "";
    public static void SaveBalanceKey(string key)
    {
        Directory.CreateDirectory(Folder);
        File.WriteAllBytes(BalanceKeyFile + ".tmp", ProtectedData.Protect(Encoding.UTF8.GetBytes(key), null, DataProtectionScope.CurrentUser));
        File.Move(BalanceKeyFile + ".tmp", BalanceKeyFile, true);
    }
    private static readonly string LiveFile = Path.Combine(Folder, "live-chunks.txt");
    public static bool LiveChunks => File.Exists(LiveFile) && File.ReadAllText(LiveFile).Trim() == "true";
    public static void SaveLiveChunks(bool enabled) { Directory.CreateDirectory(Folder); File.WriteAllText(LiveFile, enabled ? "true" : "false"); }
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
    {
        Directory.CreateDirectory(Folder);
        var encrypted = ProtectedData.Protect(Encoding.UTF8.GetBytes(key), null, DataProtectionScope.CurrentUser);
        File.WriteAllBytes(KeyFile + ".tmp", encrypted);
        File.Move(KeyFile + ".tmp", KeyFile, true);
    }
}
