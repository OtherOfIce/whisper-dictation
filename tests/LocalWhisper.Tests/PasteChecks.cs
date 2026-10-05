using System.Runtime.InteropServices;
using LocalWhisper;

internal static class PasteChecks
{
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint window, nint process);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint from, uint to, bool attach);

    internal static void Run(Action<bool, string> check)
    {
        Exception? failure = null;
        using var form = new Form { Text = "Local Whisper paste verification", Width = 400, Height = 180, TopMost = true };
        var field = new TextBox { Dock = DockStyle.Fill, Multiline = true };
        form.Controls.Add(field);
        form.Shown += async (_, _) =>
        {
            var original = Clipboard.GetDataObject();
            var paste = new Paste(form);
            var uiThread = Environment.CurrentManagedThreadId;
            var target = form.Handle;
            try
            {
                var foregroundThread = GetWindowThreadProcessId(Native.GetForegroundWindow(), 0);
                var currentThread = GetCurrentThreadId();
                AttachThreadInput(currentThread, foregroundThread, true);
                try { Native.SetForegroundWindow(target); form.Activate(); field.Focus(); }
                finally { AttachThreadInput(currentThread, foregroundThread, false); }
                check(Native.GetForegroundWindow() == target, "Paste verification requires focused test editor");
                var callbackOnUi = false;
                var focusOnUi = false;
                var result = await Task.Run(() => paste.IntoAsync("Worker thread transcript", target, default,
                    onPasted: () => callbackOnUi = Environment.CurrentManagedThreadId == uiThread && Thread.CurrentThread.GetApartmentState() == ApartmentState.STA,
                    textTarget: async (_, token) =>
                    {
                        await Task.Delay(10, token);
                        focusOnUi = Environment.CurrentManagedThreadId == uiThread && Thread.CurrentThread.GetApartmentState() == ApartmentState.STA;
                        return true;
                    }));
                await Task.Delay(80);
                check(result && field.Text == "Worker thread transcript", "Worker thread caller pastes through the module");
                check(callbackOnUi && focusOnUi, "Paste owns STA dispatch across awaits and callbacks");
                check(!await Task.Run(() => paste.IntoAsync("wrong target", (nint)12345, default)), "Worker thread paste still refuses the wrong target");
                using var cancelled = new CancellationTokenSource();
                cancelled.Cancel();
                try { await Task.Run(() => paste.IntoAsync("cancelled", target, cancelled.Token)); throw new Exception("Cancelled paste ran"); }
                catch (OperationCanceledException) { check(true, "Cancelled worker thread paste stays cancelled"); }
            }
            catch (Exception error) { failure = error; }
            finally
            {
                await Task.Delay(850); // Let delayed restoration finish before restoring the user's clipboard.
                if (original is not null) Clipboard.SetDataObject(original, true);
                form.Close();
            }
        };
        Application.Run(form);
        if (failure is not null) throw failure;
        Console.WriteLine("PASS: paste module dispatches worker thread callers to STA");
    }
}
