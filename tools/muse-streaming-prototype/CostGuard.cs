using System.Text.Json;

namespace MuseStreamingPrototype;

public sealed record UsageEntry(Guid Id, DateTime StartedUtc, int ReservedSeconds, int? SentMilliseconds);
public sealed record UsageLedger(int Version, List<UsageEntry> Entries);

public sealed class CostGuard
{
    public const decimal PublishedPricePerHour = 0.18m;
    private readonly string path;
    private readonly string lockPath;
    private readonly decimal dailyLimit;
    private readonly decimal sessionLimit;
    private readonly Func<DateTime> utcNow;

    public CostGuard(string path, decimal dailyLimit, decimal sessionLimit, Func<DateTime>? utcNow = null)
    {
        if (dailyLimit <= 0 || sessionLimit <= 0) throw new ArgumentOutOfRangeException(nameof(dailyLimit), "Cost limits must be positive.");
        this.path = Path.GetFullPath(path);
        lockPath = this.path + ".lock";
        this.dailyLimit = dailyLimit;
        this.sessionLimit = sessionLimit;
        this.utcNow = utcNow ?? (() => DateTime.UtcNow);
    }

    public static decimal Estimate(int milliseconds)
    {
        if (milliseconds <= 0) return 0;
        // Meta rounds billed audio down to a whole second. The local guard
        // rounds up so its estimate never understates the documented price.
        var conservativeSeconds = Math.Ceiling(milliseconds / 1000m);
        return PublishedPricePerHour * conservativeSeconds / 3600m;
    }

    public CostReservation Reserve(int requestedSeconds)
    {
        if (requestedSeconds is < 1 or > 300)
            throw new InvalidOperationException("A prototype session must be between 1 and 300 seconds.");

        var requestedCost = Estimate(checked(requestedSeconds * 1000));
        if (requestedCost > sessionLimit)
            throw new InvalidOperationException($"The requested session could cost {Money(requestedCost)}, above the {Money(sessionLimit)} per-session limit.");

        return WithLock(ledger =>
        {
            var today = utcNow().Date;
            var used = ledger.Entries.Where(e => e.StartedUtc.Date == today).Sum(EntryCost);
            if (used + requestedCost > dailyLimit)
                throw new InvalidOperationException($"The reservation would exceed the {Money(dailyLimit)} daily limit. Estimated today: {Money(used)}.");

            var entry = new UsageEntry(Guid.NewGuid(), utcNow(), requestedSeconds, null);
            ledger.Entries.Add(entry);
            Save(ledger);
            return new CostReservation(this, entry.Id, requestedSeconds, used, requestedCost, dailyLimit);
        });
    }

    public (decimal Used, decimal Limit) Today()
    {
        return WithLock(ledger =>
        {
            var today = utcNow().Date;
            return (ledger.Entries.Where(e => e.StartedUtc.Date == today).Sum(EntryCost), dailyLimit);
        });
    }

    internal void Reconcile(Guid id, int sentMilliseconds)
    {
        WithLock<object?>(ledger =>
        {
            var index = ledger.Entries.FindIndex(e => e.Id == id);
            if (index < 0) throw new InvalidDataException("The Muse cost reservation disappeared. Refusing to update an unknown session.");
            var entry = ledger.Entries[index];
            var capped = Math.Clamp(sentMilliseconds, 0, checked(entry.ReservedSeconds * 1000));
            ledger.Entries[index] = entry with { SentMilliseconds = capped };
            Save(ledger);
            return null;
        });
    }

    private decimal EntryCost(UsageEntry entry) => Estimate(entry.SentMilliseconds ?? checked(entry.ReservedSeconds * 1000));

    private T WithLock<T>(Func<UsageLedger, T> action)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        using var fileLock = AcquireLock();
        return action(Load());
    }

    private FileStream AcquireLock()
    {
        for (var attempt = 0; attempt < 20; attempt++)
        {
            try { return new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) when (attempt < 19) { Thread.Sleep(50); }
        }
        throw new IOException("Could not lock the Muse usage ledger. No paid request was started.");
    }

    private UsageLedger Load()
    {
        if (!File.Exists(path)) return new UsageLedger(1, []);
        try
        {
            var ledger = JsonSerializer.Deserialize<UsageLedger>(File.ReadAllBytes(path));
            if (ledger is null || ledger.Version != 1 || ledger.Entries is null)
                throw new InvalidDataException("Unsupported usage ledger format.");
            return ledger;
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            throw new InvalidDataException("The Muse usage ledger cannot be read. No paid request was started.", ex);
        }
    }

    private void Save(UsageLedger ledger)
    {
        var temporary = path + ".tmp";
        try
        {
            File.WriteAllBytes(temporary, JsonSerializer.SerializeToUtf8Bytes(ledger, new JsonSerializerOptions { WriteIndented = true }));
            File.Move(temporary, path, true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new InvalidDataException("The Muse usage ledger cannot be saved. No paid request was started.", ex);
        }
    }

    private static string Money(decimal value) => value.ToString("$0.000000");
}

public sealed class CostReservation : IDisposable
{
    private readonly CostGuard owner;
    private readonly Guid id;
    private int completed;

    internal CostReservation(CostGuard owner, Guid id, int reservedSeconds, decimal usedBefore, decimal reservedCost, decimal dailyLimit)
    {
        this.owner = owner;
        this.id = id;
        ReservedSeconds = reservedSeconds;
        UsedBefore = usedBefore;
        ReservedCost = reservedCost;
        DailyLimit = dailyLimit;
    }

    public int ReservedSeconds { get; }
    public Guid SessionId => id;
    public decimal UsedBefore { get; }
    public decimal ReservedCost { get; }
    public decimal DailyLimit { get; }

    public void Complete(int sentMilliseconds)
    {
        if (Interlocked.Exchange(ref completed, 1) != 0) return;
        owner.Reconcile(id, sentMilliseconds);
    }

    public void Dispose()
    {
        // A crash or unclean exit keeps the full reservation in the ledger.
        // That deliberately over-counts rather than allowing another session
        // to spend money that may already have been billed.
    }
}
