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
        try
        {
            var app = new EngineApp(args.Contains("--no-hook"));
            Application.Run(app);
        }
        catch { Console.Error.WriteLine("The dictation engine could not start."); Environment.ExitCode = 1; }
    }
}
