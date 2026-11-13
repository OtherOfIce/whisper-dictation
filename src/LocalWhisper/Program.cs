namespace LocalWhisper;

internal static class Program
{
    /// <summary>
    ///  The main entry point for the application.
    /// </summary>
    [STAThread]
    static void Main(string[] args)
    {
        // To customize application configuration such as set high DPI settings or default font,
        // see https://aka.ms/applicationconfiguration.
        ApplicationConfiguration.Initialize();
        if (!args.Contains("--engine")) return;
        using var singleInstance = new Mutex(true, args.Contains("--no-hook") ? @"Local\LocalWhisper.TestEngine" : @"Local\LocalWhisper.Engine", out var first);
        if (!first) return;
        // Stdout is the JSON protocol; failures go to stderr instead of a dialog the user cannot see.
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => EngineLog.Error("Unhandled UI exception", e.Exception, true);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => EngineLog.Error("Unhandled exception", e.ExceptionObject as Exception, true);
        TaskScheduler.UnobservedTaskException += (_, e) => { EngineLog.Error("Unobserved task exception", e.Exception, true); e.SetObserved(); };
        try
        {
            var app = new EngineApp(args.Contains("--no-hook"));
            Application.Run(app);
        }
        catch (Exception ex) { EngineLog.Error("The dictation engine could not start", ex); Environment.ExitCode = 1; }
    }
}

// Diagnostics for the host. Never write these to stdout, which carries the JSON protocol.
internal static class EngineLog
{
    public static void Error(string context, Exception? ex, bool stack = false)
    {
        try { Console.Error.WriteLine($"[engine] {context}: {(ex is null ? "unknown error" : stack ? ex.ToString() : $"{ex.GetType().Name}: {ex.Message}")}"); }
        catch { /* A closed stderr must not cause another failure. */ }
    }
}
