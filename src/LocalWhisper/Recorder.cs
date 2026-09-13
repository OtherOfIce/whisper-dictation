using NAudio.Wave;

namespace LocalWhisper;

internal sealed class Recorder : IDisposable
{
    private readonly WaveInEvent input = new() { DeviceNumber = -1, WaveFormat = new WaveFormat(16000, 16, 1), BufferMilliseconds = 40 };
    private readonly PauseChunks buffer = new();
    private long totalBytes;
    private readonly bool live;
    public event Action<byte[]>? ChunkReady;
    private readonly TaskCompletionSource stopped = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly object gate = new();
    private bool stopping;
    private bool disposed;
    public float Level { get; private set; }
    public double Seconds { get { lock (gate) return totalBytes / 32000d; } }
    public bool HasStopped => stopped.Task.IsCompleted;
    public Recorder(bool live = false)
    {
        this.live = live;
        input.DataAvailable += (_, e) =>
        {
            byte[]? chunk = null;
            lock (gate)
            {
                if (disposed) return;
                // Five-minute memory bound, including when the UI thread is busy.
                var count = (int)Math.Min(e.BytesRecorded, Math.Max(0, 32000L * 300 - totalBytes));
                totalBytes += count;
                float peak = 0;
                for (var i = 0; i + 1 < count; i += 2)
                    peak = Math.Max(peak, Math.Abs(BitConverter.ToInt16(e.Buffer, i) / 32768f));
                Level = peak;
                chunk = buffer.Add(e.Buffer, count, live ? peak : 1);
            }
            if (chunk is not null) ChunkReady?.Invoke(chunk);
        };
        input.RecordingStopped += (_, e) =>
        {
            if (e.Exception is not null) stopped.TrySetException(e.Exception);
            else stopped.TrySetResult();
        };
    }
    public void Start() => input.StartRecording();
    public async Task<byte[]> StopPcmAsync()
    {
        if (!stopping) { stopping = true; input.StopRecording(); }
        await stopped.Task.WaitAsync(TimeSpan.FromSeconds(5));
        lock (gate) return buffer.Drain();
    }
    public async Task<byte[]> StopAsync()
    {
        var pcm = await StopPcmAsync();
        using var wav = new MemoryStream();
        using (var writer = new WaveFileWriter(new NAudio.Utils.IgnoreDisposeStream(wav), input.WaveFormat))
        {
            writer.Write(pcm, 0, pcm.Length);
        }
        return wav.ToArray();
    }
    public void Dispose()
    {
        input.Dispose();
        lock (gate) { disposed = true; buffer.Drain(); }
    }
}
