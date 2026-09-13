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
    private static readonly string CleanupFile = Path.Combine(Folder, "cleanup-mode.txt");
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
