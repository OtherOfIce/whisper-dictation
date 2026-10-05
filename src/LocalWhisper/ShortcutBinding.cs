using System.Runtime.InteropServices;

namespace LocalWhisper;

// Modifier bits use the Windows RegisterHotKey convention: Alt, Ctrl, Shift, Win.
internal sealed record ShortcutBinding(int Modifiers, int Key)
{
    public static readonly ShortcutBinding Default = new(10, 0);
    public void Validate()
    {
        if (Modifiers < 1 || Modifiers > 15 || (Key == 0 ? System.Numerics.BitOperations.PopCount((uint)Modifiers) < 2
            : !IsSupportedKey(Key)))
            throw new InvalidOperationException("Use two or more modifiers, or a modifier with a letter, number, function key, or Space.");
        if (Key == 0x7B || (Key == 0x20 && (Modifiers & 8) != 0))
            throw new InvalidOperationException("That shortcut is reserved by Windows. Choose another combination.");
    }
    public static bool IsSupportedKey(int key) => key is >= 0x30 and <= 0x39 or >= 0x41 and <= 0x5A or >= 0x70 and <= 0x87 or 0x20;
    public static int Modifier(uint key) => key switch
    {
        0x12 or 0xA4 or 0xA5 => 1, 0x11 or 0xA2 or 0xA3 => 2,
        0x10 or 0xA0 or 0xA1 => 4, 0x5B or 0x5C => 8, _ => 0
    };
    public bool Matches(IReadOnlySet<uint> down) => down.Aggregate(0, (mask, key) => mask | Modifier(key)) == Modifiers
        && (Key == 0 || down.Contains((uint)Key));
    public void CheckAvailable()
    {
        Validate();
        // Windows cannot register modifier-only shortcuts. For other chords, probe ownership
        // without replacing the low-level hook used for hold/release and double-tap behavior.
        if (Key == 0) return;
        if (!RegisterHotKey(0, 0x5748, (uint)Modifiers | 0x4000, (uint)Key))
            throw new InvalidOperationException("That shortcut is reserved or already registered by another app. Choose another combination.");
        UnregisterHotKey(0, 0x5748);
    }
    [DllImport("user32.dll", SetLastError = true)] private static extern bool RegisterHotKey(nint window, int id, uint modifiers, uint key);
    [DllImport("user32.dll")] private static extern bool UnregisterHotKey(nint window, int id);
}
