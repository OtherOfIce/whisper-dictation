using NAudio.Wave;

namespace LocalWhisper;

internal sealed class TranscriptionSession(HttpClient http, string key, SessionMetrics metrics, CancellationToken token,
    IReadOnlyList<string>? dictionaryTerms = null, string transcriptionModel = TranscriptionModels.MaiClean)
{
    private readonly string[] dictionary = dictionaryTerms?.ToArray() ?? [];
    private readonly List<Task<string>> chunks = [];
    private readonly SemaphoreSlim slots = new(2);
    private readonly object gate = new();
    private int completed;
    public int Completed => Volatile.Read(ref completed);
    public int Count { get { lock (gate) return chunks.Count; } }
    public void EnqueuePcm(byte[] pcm)
    {
        if (pcm.Length == 0 || token.IsCancellationRequested) return;
        lock (gate)
        {
            var number = chunks.Count + 1;
            // Task.Run keeps compression and serialization off both the UI and capture threads.
            chunks.Add(Task.Run(async () =>
            {
                var prefix = $"Part {number} · ";
                using (metrics.Measure(prefix + "Queue")) await slots.WaitAsync(token).ConfigureAwait(false);
                try
                {
                    token.ThrowIfCancellationRequested();
                    using var wav = new MemoryStream();
                    using (var writer = new WaveFileWriter(new NAudio.Utils.IgnoreDisposeStream(wav), new WaveFormat(16000, 16, 1)))
                        writer.Write(pcm, 0, pcm.Length);
                    (byte[] Bytes, string Format) encoded;
                    using (metrics.Measure(prefix + "Compress audio"))
                    {
                        try { encoded = AudioEncoding.Compress(wav.ToArray()); }
                        catch (Exception ex) when (ex is System.Runtime.InteropServices.COMException or InvalidOperationException)
                        {
                            using (metrics.Measure(prefix + "MP3 unavailable; using WAV")) encoded = (wav.ToArray(), "wav");
                        }
                    }
                    token.ThrowIfCancellationRequested();
                    var result = await new Transcriber(http).TranscribeAsync(encoded.Bytes, key, token, metrics, prefix, encoded.Format, dictionary, transcriptionModel).ConfigureAwait(false);
                    Interlocked.Increment(ref completed);
                    return result;
                }
                finally { slots.Release(); }
            }, token));
            // Observe early failures even if the user later cancels rather than pressing Finish.
            _ = chunks[^1].ContinueWith(t => _ = t.Exception, TaskContinuationOptions.OnlyOnFaulted);
        }
    }
    // Recorder must have stopped before this is called, so no more chunks can arrive.
    public async Task<string> FinishAsync()
    {
        Task<string>[] pending;
        lock (gate) pending = chunks.ToArray();
        var results = await Task.WhenAll(pending).ConfigureAwait(false);
        token.ThrowIfCancellationRequested();
        return string.Join(" ", results.Where(t => !string.IsNullOrWhiteSpace(t)));
    }
}
