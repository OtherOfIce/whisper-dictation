using MuseStreamingPrototype;

const int DefaultSeconds = 60;
const decimal DefaultDailyLimit = 0.05m;
const decimal DefaultSessionLimit = 0.01m;

try
{
    var options = Parse(args);
    var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LocalWhisper");
    var ledgerPath = options.Ledger ?? Path.Combine(folder, "muse-prototype-usage.json");
    var guard = new CostGuard(ledgerPath, options.DailyLimit, options.SessionLimit);
    var status = guard.Today();

    Console.WriteLine("Muse Voice Transcribe streaming prototype");
    Console.WriteLine($"Published estimate: {Usd(CostGuard.PublishedPricePerHour)}/audio hour");
    Console.WriteLine($"Hard stop: {options.Seconds}s ({Usd(CostGuard.Estimate(options.Seconds * 1000))} maximum estimated charge)");
    Console.WriteLine($"Estimated UTC-day usage: {Usd(status.Used)} / {Usd(status.Limit)}");
    Console.WriteLine("This ledger is a local estimate, not Meta's billing record.");
    WarnNearDailyLimit(status.Used, status.Limit);

    if (!options.Live)
    {
        Console.WriteLine("Safety preview only. No microphone was opened and no network request was made.");
        Console.WriteLine("Pass --live to reserve the maximum cost and test the microphone stream.");
        return 0;
    }

    var key = Environment.GetEnvironmentVariable("MODEL_API_KEY");
    if (string.IsNullOrWhiteSpace(key)) throw new InvalidOperationException("Set MODEL_API_KEY before using --live. The prototype does not save API keys.");

    using var reservation = guard.Reserve(options.Seconds);
    var reservedDayTotal = reservation.UsedBefore + reservation.ReservedCost;
    Console.WriteLine($"Reserved {Usd(reservation.ReservedCost)}; estimated day total is now {Usd(reservedDayTotal)}.");
    WarnNearDailyLimit(reservedDayTotal, reservation.DailyLimit);
    Console.Write("Type START to open the microphone and paid stream: ");
    if (!string.Equals(Console.ReadLine(), "START", StringComparison.Ordinal))
    {
        reservation.Complete(0);
        Console.WriteLine("Cancelled. No network request was made.");
        return 0;
    }

    using var stop = new CancellationTokenSource();
    ConsoleCancelEventHandler cancel = (_, eventArgs) => { eventArgs.Cancel = true; stop.Cancel(); };
    Console.CancelKeyPress += cancel;
    await using var client = new MuseStreamClient();
    try
    {
        var transcript = await client.RunAsync(key, reservation.SessionId, options.Seconds, options.Keywords, options.BearerPrefix, stop.Token);
        Console.WriteLine($"Final: {transcript}");
    }
    finally
    {
        reservation.Complete(client.AccountedMilliseconds);
        Console.CancelKeyPress -= cancel;
        var final = guard.Today();
        Console.WriteLine($"Sent {client.SentMilliseconds / 1000d:F2}s; provider acknowledged {client.AccountedMilliseconds / 1000d:F2}s at most.");
        Console.WriteLine($"Conservative estimated charge: {Usd(CostGuard.Estimate(client.AccountedMilliseconds))}.");
        Console.WriteLine($"Estimated UTC-day usage: {Usd(final.Used)} / {Usd(final.Limit)}");
        WarnNearDailyLimit(final.Used, final.Limit);
    }
    return 0;
}
catch (Exception ex)
{
    Console.Error.WriteLine(ex.Message);
    return 1;
}

static Options Parse(string[] args)
{
    var live = false;
    var seconds = DefaultSeconds;
    var daily = DefaultDailyLimit;
    var session = DefaultSessionLimit;
    string? ledger = null;
    var keywords = new List<string>();
    var bearerPrefix = true;
    for (var i = 0; i < args.Length; i++)
    {
        string Value() => i + 1 < args.Length ? args[++i] : throw new ArgumentException($"Missing value after {args[i]}.");
        switch (args[i])
        {
            case "--live": live = true; break;
            case "--seconds" when int.TryParse(Value(), out var value): seconds = value; break;
            case "--daily-limit" when decimal.TryParse(Value(), out var value): daily = value; break;
            case "--session-limit" when decimal.TryParse(Value(), out var value): session = value; break;
            case "--ledger": ledger = Value(); break;
            case "--keyword": keywords.Add(Value()); break;
            case "--raw-token": bearerPrefix = false; break;
            default: throw new ArgumentException($"Unknown or invalid argument: {args[i]}");
        }
    }
    return new Options(live, seconds, daily, session, ledger, keywords, bearerPrefix);
}

static string Usd(decimal value) => "$" + value.ToString("0.000000", System.Globalization.CultureInfo.InvariantCulture);

static void WarnNearDailyLimit(decimal used, decimal limit)
{
    if (used >= limit * 0.8m)
        Console.Error.WriteLine($"WARNING: estimated Muse usage has reached {used / limit:P0} of the local daily limit.");
}

sealed record Options(bool Live, int Seconds, decimal DailyLimit, decimal SessionLimit, string? Ledger, IReadOnlyList<string> Keywords, bool BearerPrefix);
