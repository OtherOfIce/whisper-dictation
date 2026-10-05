using System.ComponentModel;
using System.Runtime.InteropServices;

namespace LocalWhisper;

internal static class Native
{
    internal delegate nint HookProc(int code, nint message, nint data);
    [DllImport("user32.dll", SetLastError = true)] internal static extern nint SetWindowsHookEx(int id, HookProc callback, nint module, uint thread);
    [DllImport("user32.dll")] internal static extern bool UnhookWindowsHookEx(nint hook);
    [DllImport("user32.dll")] internal static extern nint CallNextHookEx(nint hook, int code, nint message, nint data);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] internal static extern nint GetModuleHandle(string? name);
    [DllImport("user32.dll")] internal static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] internal static extern bool SetForegroundWindow(nint window);
    [DllImport("user32.dll")] internal static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] internal static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, Input[] inputs, int size);
    [StructLayout(LayoutKind.Sequential)] internal struct KeyEvent { public uint Key, Scan, Flags, Time; public nuint Extra; }
    [StructLayout(LayoutKind.Sequential)] private struct Input { public uint Type; public InputUnion Data; }
    [StructLayout(LayoutKind.Explicit)] private struct InputUnion
    {
        [FieldOffset(0)] public Keyboard Keyboard;
        [FieldOffset(0)] public Mouse Mouse;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Keyboard { public ushort Key, Scan; public uint Flags, Time; public nuint Extra; }
    [StructLayout(LayoutKind.Sequential)] private struct Mouse { public int X, Y; public uint Data, Flags, Time; public nuint Extra; }
    internal static bool ModifiersDown => new[] { 0x10, 0x11, 0x12, 0x5B, 0x5C }.Any(k => (GetAsyncKeyState(k) & 0x8000) != 0);
    internal static void Keys(params (ushort key, bool up)[] keys)
    {
        var inputs = keys.Select(k => new Input { Type = 1, Data = new InputUnion { Keyboard = new Keyboard { Key = k.key, Flags = k.up ? 2u : 0 } } }).ToArray();
        if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Input>()) != inputs.Length)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows could not send keystrokes to this window.");
    }
}

internal sealed class GlobalShortcut : IDisposable
{
    private readonly Native.HookProc callback;
    private readonly nint hook;
    private readonly HashSet<uint> down = [];
    private readonly HashSet<uint> suppressed = [];
    public event Action<bool>? Changed;
    public event Action? EscapePressed;
    public event Action<ShortcutBinding?>? Captured;
    private ShortcutBinding binding = ShortcutBinding.Default;
    private int captureModifiers, captureKey;
    public bool Capturing { get; private set; }
    public void Configure(ShortcutBinding value) { binding = value; down.Clear(); }
    public void Capture(bool enabled)
    {
        Capturing = enabled; captureModifiers = captureKey = 0; down.Clear();
    }
    public GlobalShortcut(bool noHook = false)
    {
        callback = OnKey;
        if (noHook) return;
        hook = Native.SetWindowsHookEx(13, callback, Native.GetModuleHandle(null), 0);
        if (hook == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    private bool Chord => binding.Matches(down);
    private nint OnKey(int code, nint message, nint data)
    {
        if (code < 0) return Native.CallNextHookEx(hook, code, message, data);
        var key = Marshal.PtrToStructure<Native.KeyEvent>(data);
        if ((key.Flags & 0x10) != 0) return Native.CallNextHookEx(hook, code, message, data);
        return ProcessKey(key.Key, (key.Flags & 0x80) != 0) ? 1 : Native.CallNextHookEx(hook, code, message, data);
    }
    internal bool ProcessKey(uint key, bool up)
    {
        if (key == 0x1B)
        {
            if (!up)
            {
                if (Capturing) { Capture(false); Captured?.Invoke(null); }
                else EscapePressed?.Invoke();
            }
            return false;
        }
        bool was = Chord;
        if (up) down.Remove(key); else down.Add(key);
        if (Capturing)
        {
            if (!up)
            {
                captureModifiers |= ShortcutBinding.Modifier(key);
                if (ShortcutBinding.Modifier(key) == 0) captureKey = (int)key;
                suppressed.Add(key);
            }
            bool capturedSwallow = suppressed.Contains(key);
            if (up)
            {
                suppressed.Remove(key);
                if (captureKey != 0 || System.Numerics.BitOperations.PopCount((uint)captureModifiers) >= 2)
                {
                    var candidate = new ShortcutBinding(captureModifiers, captureKey);
                    if (hook != 0 && (captureModifiers & 8) != 0)
                        try { Native.Keys((0xE8, false), (0xE8, true)); } catch (Win32Exception) { }
                    Capture(false); Captured?.Invoke(candidate);
                }
                else if (down.Count == 0) captureModifiers = 0;
            }
            return capturedSwallow;
        }
        bool now = Chord;
        if (!was && now)
        {
            suppressed.Add(key);
            // Mask Start menu activation when Win was the first key held.
            if (hook != 0 && (binding.Modifiers & 8) != 0)
                try { Native.Keys((0xE8, false), (0xE8, true)); } catch (Win32Exception) { }
        }
        bool swallow = suppressed.Contains(key);
        if (up) suppressed.Remove(key);
        if (was != now) Changed?.Invoke(now);
        return swallow;
    }
    public void Dispose() => Native.UnhookWindowsHookEx(hook);
}

internal sealed class Paste
{
    private readonly Control dispatcher;

    public Paste(Control dispatcher)
    {
        ArgumentNullException.ThrowIfNull(dispatcher);
        if (Thread.CurrentThread.GetApartmentState() != ApartmentState.STA || dispatcher.InvokeRequired)
            throw new InvalidOperationException("Create the paste module on the UI thread.");
        _ = dispatcher.Handle;
        this.dispatcher = dispatcher;
    }

    // Callers can be on any thread. Dispatch the whole operation so awaits, callbacks,
    // and delayed clipboard restoration all run on the owning UI thread.
    public async Task<bool> IntoAsync(string text, nint target, CancellationToken cancellation, Action? onPasted = null, SessionMetrics? metrics = null, Func<nint, CancellationToken, Task<bool?>>? textTarget = null)
    {
        cancellation.ThrowIfCancellationRequested();
        return await dispatcher.InvokeAsync<bool>(async token =>
            await IntoOnUiAsync(text, target, token, onPasted, metrics, textTarget), cancellation);
    }

    private static async Task<bool> IntoOnUiAsync(string text, nint target, CancellationToken cancellation, Action? onPasted, SessionMetrics? metrics, Func<nint, CancellationToken, Task<bool?>>? textTarget)
    {
        for (var i = 0; Native.ModifiersDown && i < 100; i++) await Task.Delay(25, cancellation);
        cancellation.ThrowIfCancellationRequested();
        if (Native.ModifiersDown || target == 0 || Native.GetForegroundWindow() != target) return false;
        // Refuse targets with no editable focus (desktop, non-editable windows). An inconclusive
        // check (null) fails open so paste behavior is unchanged when UI Automation cannot tell.
        if (textTarget is not null && await textTarget(target, cancellation) is false) return false;
        cancellation.ThrowIfCancellationRequested();
        IDataObject? previous = null;
        try { previous = Clipboard.GetDataObject(); } catch (ExternalException) { }
        Clipboard.SetText(text);
        var sequence = Native.GetClipboardSequenceNumber();
        try
        {
            if (Native.GetForegroundWindow() != target) { Restore(previous, sequence); return false; }
            Native.Keys((0x11, false), (0x56, false), (0x56, true), (0x11, true));
            onPasted?.Invoke();
            // Clipboard cleanup must not keep dictation busy for another 700 ms.
            _ = RestoreLaterAsync(previous, sequence, metrics);
            return true;
        }
        catch
        {
            Restore(previous, sequence);
            throw;
        }
    }
    private static async Task RestoreLaterAsync(IDataObject? previous, uint sequence, SessionMetrics? metrics)
    {
        using (metrics?.Measure("Clipboard cleanup (after paste)"))
        {
            await Task.Delay(700);
            Restore(previous, sequence);
        }
    }
    private static void Restore(IDataObject? previous, uint sequence)
    {
        if (previous is not null && Native.GetClipboardSequenceNumber() == sequence)
            try { Clipboard.SetDataObject(previous, true); } catch (Exception ex) when (ex is ExternalException or System.Runtime.InteropServices.COMException) { }
    }
}
