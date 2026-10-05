using LocalWhisper;
using System.Runtime.InteropServices;

internal static class ShortcutChecks
{
    [DllImport("user32.dll")] private static extern bool RegisterHotKey(nint window, int id, uint modifiers, uint key);
    [DllImport("user32.dll")] private static extern bool UnregisterHotKey(nint window, int id);
    public static void Run(Action<bool, string> check)
    {
        check(ShortcutBinding.Default.Matches(new HashSet<uint> { 0xA2, 0x5C }), "Default shortcut accepts either Win key");
        check(ShortcutBinding.Default.Matches(new HashSet<uint> { 0xA3, 0x5B }), "Default shortcut accepts either Ctrl key");
        var binding = new ShortcutBinding(6, 0x44);
        binding.Validate();
        var serialized = System.Text.Json.JsonSerializer.Serialize(binding);
        check(System.Text.Json.JsonSerializer.Deserialize<ShortcutBinding>(serialized) == binding, "Saved shortcut round-trips without losing modifiers or key");
        if (RegisterHotKey(0, 0x5343, 7, 0x87))
        {
            try
            {
                try { new ShortcutBinding(7, 0x87).CheckAvailable(); throw new Exception("Registered shortcut conflict was accepted"); }
                catch (InvalidOperationException) { check(true, "Already registered shortcut is rejected"); }
            }
            finally { UnregisterHotKey(0, 0x5343); }
        }
        check(binding.Matches(new HashSet<uint> { 0xA2, 0xA1, 0x44 }), "Ctrl Shift D matches physical modifier keys");
        check(!binding.Matches(new HashSet<uint> { 0xA2, 0x44 }), "Missing modifier does not activate a shortcut");
        check(!binding.Matches(new HashSet<uint> { 0xA2, 0xA1, 0xA4, 0x44 }), "Extra modifiers do not activate a different shortcut");
        foreach (var invalid in new[] { new ShortcutBinding(0, 0x44), new ShortcutBinding(2, 0), new ShortcutBinding(16, 0x44), new ShortcutBinding(2, 0x1B), new ShortcutBinding(2, 0x7B) })
        {
            try { invalid.Validate(); throw new Exception("Invalid shortcut was accepted"); }
            catch (InvalidOperationException) { check(true, "Invalid or reserved shortcut is rejected"); }
        }
        using var hook = new GlobalShortcut(noHook: true);
        hook.Configure(binding);
        var transitions = new List<bool>();
        hook.Changed += transitions.Add;
        hook.ProcessKey(0xA2, false); hook.ProcessKey(0xA1, false);
        check(hook.ProcessKey(0x44, false), "Shortcut activating key is swallowed");
        check(hook.ProcessKey(0x44, false), "Autorepeat remains swallowed");
        check(transitions.SequenceEqual(new[] { true }), "Autorepeat does not start another recording");
        check(hook.ProcessKey(0x44, true), "Activating key release is swallowed");
        check(transitions.SequenceEqual(new[] { true, false }), "Push-to-talk sees one press and one release");
        hook.ProcessKey(0xA2, true); hook.ProcessKey(0xA1, true);
        ShortcutBinding? captured = null;
        hook.Captured += value => captured = value;
        hook.Capture(true);
        hook.ProcessKey(0xA3, false); hook.ProcessKey(0xA0, false); hook.ProcessKey(0x46, false); hook.ProcessKey(0x46, true);
        check(captured == new ShortcutBinding(6, 0x46) && !hook.Capturing, "Capture records a conventional chord and ends on release");
        check(transitions.Count == 2, "Capture never activates dictation");
        check(hook.ProcessKey(0xA3, true) && hook.ProcessKey(0xA0, true), "Captured modifier releases remain swallowed");
        hook.Capture(true); captured = null;
        hook.ProcessKey(0xA2, false); hook.ProcessKey(0x5B, false); hook.ProcessKey(0x5B, true);
        check(captured == ShortcutBinding.Default, "Capture supports modifier-only shortcuts");
        hook.ProcessKey(0xA2, true);
        hook.Capture(true); hook.ProcessKey(0x1B, false);
        check(!hook.Capturing && captured is null, "Escape cancels capture");
        hook.Configure(new ShortcutBinding(3, 0));
        hook.ProcessKey(0xA2, false); hook.ProcessKey(0xA4, false); hook.ProcessKey(0xA2, true); hook.ProcessKey(0xA4, true);
        check(transitions.TakeLast(2).SequenceEqual(new[] { true, false }), "Rebound modifier-only shortcut keeps press and release behavior");
    }
}
