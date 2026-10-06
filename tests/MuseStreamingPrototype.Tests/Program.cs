using MuseStreamingPrototype;

var checks = 0;
var root = Path.Combine(Path.GetTempPath(), "muse-cost-tests-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
try
{
    var now = new DateTime(2026, 9, 17, 12, 0, 0, DateTimeKind.Utc);
    var path = Path.Combine(root, "usage.json");
    var guard = new CostGuard(path, 0.005m, 0.004m, () => now);
    Check(CostGuard.Estimate(60_000) == 0.003m, "Published per-hour price converts to a per-minute estimate");
    Check(CostGuard.Estimate(1) == 0.00005m, "The local estimate rounds partial seconds up for safety");

    using (var reservation = guard.Reserve(60))
    {
        Check(guard.Today().Used == 0.003m, "A pending session counts its full reservation");
        reservation.Complete(10_000);
    }
    Check(guard.Today().Used == 0.0005m, "A completed session is reconciled to audio sent");

    using (guard.Reserve(60)) { }
    Check(guard.Today().Used == 0.0035m, "An unclean session keeps its full reservation");
    ExpectFailure(() => guard.Reserve(60), "The daily cap blocks a new paid session before connection");
    ExpectFailure(() => guard.Reserve(301), "The five-minute absolute session cap cannot be overridden");

    var strict = new CostGuard(Path.Combine(root, "strict.json"), 1m, 0.002m, () => now);
    ExpectFailure(() => strict.Reserve(60), "The per-session cap is checked independently");

    now = now.AddDays(1);
    Check(guard.Today().Used == 0m, "Daily usage rolls over on a UTC boundary");

    var corruptPath = Path.Combine(root, "corrupt.json");
    File.WriteAllText(corruptPath, "not json");
    var corrupt = new CostGuard(corruptPath, 1m, 1m, () => now);
    ExpectFailure(() => corrupt.Reserve(1), "A corrupt ledger fails closed");

    Console.WriteLine($"PASS: {checks} checks");
    return;

    void Check(bool condition, string description)
    {
        if (!condition) throw new Exception(description);
        checks++;
    }

    void ExpectFailure(Action action, string description)
    {
        try { action(); throw new Exception(description); }
        catch (InvalidOperationException) { checks++; }
        catch (InvalidDataException) { checks++; }
    }
}
finally
{
    Directory.Delete(root, true);
}
