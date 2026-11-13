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
    // Devices muted by a dictation are listed here until restored, so a crash cannot leave the PC silent.
    private static readonly string MutedFile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LocalWhisper", "muted-devices.txt");
    public static Task RecoverMutedAsync() => Task.Run(async () =>
    {
        await gate.WaitAsync();
        try { RecoverMuted(MutedFile, WindowsAudio.Unmute); }
        catch (Exception ex) { EngineLog.Error("Restoring muted devices", ex); }
        finally { gate.Release(); }
    });
    internal static void RecoverMuted(string file, Action<string> unmute)
    {
        if (!File.Exists(file)) return;
        foreach (var id in File.ReadAllLines(file).Where(line => line.Length > 0))
            try { unmute(id); } catch { /* The device may be gone; nothing else can restore it. */ }
        File.Delete(file);
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
            if (muted.Count > 0)
                try { Directory.CreateDirectory(Path.GetDirectoryName(MutedFile)!); File.WriteAllLines(MutedFile, muted.Select(device => device.ID)); }
                catch (Exception ex) { EngineLog.Error("Recording muted devices", ex); }
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
        public static void Unmute(string id)
        {
            using var devices = new MMDeviceEnumerator();
            using var device = devices.GetDevice(id);
            device.AudioEndpointVolume.Mute = false;
        }
        public async Task RestoreAsync()
        {
            foreach (var device in muted)
            {
                try { device.AudioEndpointVolume.Mute = false; }
                catch { }
                finally { try { device.Dispose(); } catch { } }
            }
            if (muted.Count > 0) try { File.Delete(MutedFile); } catch { }
            muted.Clear();
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
