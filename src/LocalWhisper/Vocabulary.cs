using System.Security.Cryptography;
using System.Text.Json;

namespace LocalWhisper;

internal static class Vocabulary
{
    public static string[] Normalize(IEnumerable<string?> terms)
    {
        var result = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var characters = 0;
        foreach (var value in terms)
        {
            var term = value?.Trim() ?? "";
            if (term.Length == 0) continue;
            if (term.Length > 120 || term.Any(char.IsControl))
                throw new InvalidOperationException("Each dictionary term must be one line, up to 120 characters.");
            if (!seen.Add(term)) continue;
            characters += term.Length + (result.Count == 0 ? 0 : 1);
            if (result.Count >= 1000 || characters > 12000)
                throw new InvalidOperationException("Keep the dictionary within 1,000 terms and 12,000 characters.");
            result.Add(term);
        }
        return result.ToArray();
    }

    public static string[] Load(string path) => !File.Exists(path) ? [] : Normalize(
        JsonSerializer.Deserialize<string[]>(ProtectedData.Unprotect(File.ReadAllBytes(path), null, DataProtectionScope.CurrentUser))
        ?? throw new InvalidDataException("Dictionary data could not be read."));

    public static void Save(string path, IEnumerable<string?> terms)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(Normalize(terms));
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        File.WriteAllBytes(path + ".tmp", ProtectedData.Protect(bytes, null, DataProtectionScope.CurrentUser));
        File.Move(path + ".tmp", path, true);
    }
}
