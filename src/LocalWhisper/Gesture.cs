namespace LocalWhisper;

public enum CaptureMode { Idle, Held, WaitingForTap, Locked, Busy }
public enum GestureAction { None, Start, Finish }

// Caller-supplied time makes double-tap boundaries testable without a keyboard.
public sealed class Gesture
{
    public const int TapMilliseconds = 250;
    public const int DoubleTapMilliseconds = 350;
    public CaptureMode Mode { get; private set; }
    public bool LockByDefault { get; set; }
    private long pressedAt;
    private long releasedAt;
    public Gesture(bool lockByDefault = false) => LockByDefault = lockByDefault;
    public GestureAction Press(long now)
    {
        if (Mode == CaptureMode.Idle)
        {
            pressedAt = now;
            Mode = LockByDefault ? CaptureMode.Locked : CaptureMode.Held;
            return GestureAction.Start;
        }
        if (Mode == CaptureMode.WaitingForTap && now - releasedAt <= DoubleTapMilliseconds)
            Mode = CaptureMode.Locked;
        else if (Mode == CaptureMode.Locked || Mode == CaptureMode.WaitingForTap)
            return Finish();
        return GestureAction.None;
    }
    public GestureAction Release(long now)
    {
        if (Mode != CaptureMode.Held) return GestureAction.None;
        if (now - pressedAt > TapMilliseconds) return Finish();
        releasedAt = now;
        Mode = CaptureMode.WaitingForTap;
        return GestureAction.None;
    }
    public GestureAction Tick(long now) => Mode == CaptureMode.WaitingForTap &&
        now - releasedAt > DoubleTapMilliseconds ? Finish() : GestureAction.None;
    public GestureAction Finish()
    {
        if (Mode is CaptureMode.Idle or CaptureMode.Busy) return GestureAction.None;
        Mode = CaptureMode.Busy;
        return GestureAction.Finish;
    }
    public void Reset() => Mode = CaptureMode.Idle;
}
