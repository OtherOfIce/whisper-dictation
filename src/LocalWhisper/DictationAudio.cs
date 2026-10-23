using NAudio.CoreAudioApi;
using Windows.Media.Control;

namespace LocalWhisper;

// Serialize leases so a cancelled dictation cannot restore audio over a newer one.
internal sealed class DictationAudio
{
    private static readonly SemaphoreSlim gate = new(1);
    private readonly TaskCompletionSource released = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<DictationAudio, byte> active = new();
    private readonly Task lifetime;
    private readonly Func<Task> interrupt;
    private readonly Func<Task> restore;

    public DictationAudio() : this(new WindowsAudio()) { }
    private DictationAudio(WindowsAudio audio) : this(audio.InterruptAsync, audio.RestoreAsync) { }
    internal DictationAudio(Func<Task> interrupt, Func<Task> restore)
    {
        this.interrupt = interrupt;
        this.restore = restore;
        active.TryAdd(this, 0);
        lifetime = Task.Run(RunAsync);
    }
    public static Task RestoreAllAsync() => Task.WhenAll(active.Keys.Select(item => item.RestoreAsync()));
    public Task RestoreAsync() { released.TrySetResult(); return lifetime; }

    private async Task RunAsync()
    {
        await gate.WaitAsync();
        try
        {
            if (!released.Task.IsCompleted)
            {
                await interrupt();
                await released.Task;
            }
        }
        catch { /* Audio control must never prevent dictation. */ }
        finally
        {
            try { await restore(); }
            catch { }
            finally { active.TryRemove(this, out _); gate.Release(); }
        }
    }

    private sealed class WindowsAudio
    {
        private readonly List<MMDevice> muted = [];
        private readonly List<GlobalSystemMediaTransportControlsSession> paused = [];
        public async Task InterruptAsync()
        {
            // Cover players without media controls, and silence playback while pause is pending.
            try
            {
                using var devices = new MMDeviceEnumerator();
                foreach (var device in devices.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
                {
                    try
                    {
                        if (!device.AudioEndpointVolume.Mute)
                        {
                            device.AudioEndpointVolume.Mute = true;
                            muted.Add(device);
                        }
                        else device.Dispose();
                    }
                    catch { device.Dispose(); }
                }
            }
            catch { /* Audio control must never prevent dictation. */ }
            try
            {
                var manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
                foreach (var session in manager.GetSessions())
                {
                    try
                    {
                        var info = session.GetPlaybackInfo();
                        if (info.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing
                            && info.Controls.IsPauseEnabled && await session.TryPauseAsync())
                            paused.Add(session);
                    }
                    catch { /* A player may close while being paused. */ }
                }
            }
            catch { /* Muting still covers systems without media controls. */ }
        }
        public async Task RestoreAsync()
        {
            foreach (var device in muted)
            {
                try { device.AudioEndpointVolume.Mute = false; }
                catch { }
                finally { try { device.Dispose(); } catch { } }
            }
            foreach (var session in paused)
            {
                try
                {
                    if (session.GetPlaybackInfo().PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Paused)
                        await session.TryPlayAsync();
                }
                catch { }
            }
        }
    }
}
