using System.Threading.Channels;

namespace LocalWhisper.Streaming;

// Owns the session lifetime. Provider adapters only implement their wire contract.
internal sealed class StreamingSession : ITranscriptionSession
{
    private readonly Channel<byte[]> audio = Channel.CreateUnbounded<byte[]>(new UnboundedChannelOptions { SingleReader = true });
    private readonly CancellationTokenSource lifetime;
    private readonly CancellationToken callerToken;
    private readonly IStreamingProtocol protocol;
    private readonly SessionMetrics metrics;
    private readonly Func<IStreamingTransport> transportFactory;
    private readonly long queueLimit;
    private readonly TimeSpan connectTimeout, finishTimeout;
    private readonly Task<string> worker;
    private long queuedBytes, audioBytes;
    private int count, completed, inputSent;
    private Exception? failure;
    public int Count => Volatile.Read(ref count);
    public int Completed => Volatile.Read(ref completed);
    public int Failed => Failure is null ? 0 : 1;
    public string? LastError => Failure?.Message;
    public Exception? Failure => Volatile.Read(ref failure);

    internal StreamingSession(IStreamingProtocol protocol, SessionMetrics metrics, CancellationToken token,
        Func<IStreamingTransport>? transportFactory = null, long queueLimit = 32000 * 30,
        TimeSpan? connectTimeout = null, TimeSpan? finishTimeout = null)
    {
        this.protocol = protocol; this.metrics = metrics; callerToken = token;
        this.transportFactory = transportFactory ?? (() => new StreamingTransport());
        this.queueLimit = queueLimit;
        this.connectTimeout = connectTimeout ?? TimeSpan.FromSeconds(15);
        this.finishTimeout = finishTimeout ?? TimeSpan.FromSeconds(30);
        lifetime = CancellationTokenSource.CreateLinkedTokenSource(token);
        worker = Task.Run(RunAsync);
        _ = worker.ContinueWith(task => _ = task.Exception, TaskContinuationOptions.OnlyOnFaulted);
    }
    public void EnqueuePcm(byte[] pcm)
    {
        if (pcm.Length == 0 || callerToken.IsCancellationRequested || Failure is not null) return;
        if (pcm.Length % 2 != 0) { Fail(new InvalidDataException("Streaming PCM contains an incomplete sample.")); return; }
        if (Interlocked.Add(ref queuedBytes, pcm.Length) > queueLimit)
        {
            Interlocked.Add(ref queuedBytes, -pcm.Length);
            Fail(new InvalidDataException("Streaming audio queue exceeded its limit. The recording will be used for recovery."));
            return;
        }
        if (!audio.Writer.TryWrite(pcm)) { Interlocked.Add(ref queuedBytes, -pcm.Length); return; }
        Interlocked.Add(ref audioBytes, pcm.Length);
        Interlocked.Increment(ref count);
    }
    // Completing the channel is idempotent; every caller observes the same result.
    public Task<string> FinishAsync() { audio.Writer.TryComplete(); return worker; }
    internal async Task ReplayAsync(byte[] pcm)
    {
        for (var offset = 0; offset < pcm.Length; offset += protocol.FrameBytes)
        {
            callerToken.ThrowIfCancellationRequested();
            while (Volatile.Read(ref queuedBytes) >= queueLimit / 2 && !worker.IsCompleted)
                await Task.Delay(10, callerToken).ConfigureAwait(false);
            if (worker.IsCompleted) { await worker.ConfigureAwait(false); return; }
            EnqueuePcm(pcm.AsSpan(offset, Math.Min(protocol.FrameBytes, pcm.Length - offset)).ToArray());
        }
    }
    private void Fail(Exception error)
    {
        Interlocked.CompareExchange(ref failure, error, null);
        audio.Writer.TryComplete(error);
        try { lifetime.Cancel(); } catch (ObjectDisposedException) { }
    }
    private async Task<string> RunAsync()
    {
        Task? send = null; Task<string>? receive = null;
        var token = lifetime.Token;
        try
        {
            using var transport = transportFactory();
            using (metrics.Measure("Connect streaming transcription"))
            using (var connect = CancellationTokenSource.CreateLinkedTokenSource(token))
            {
                connect.CancelAfter(connectTimeout);
                try { await protocol.ConnectAsync(transport, connect.Token).ConfigureAwait(false); }
                catch (OperationCanceledException) when (!token.IsCancellationRequested)
                { throw new TimeoutException("Streaming transcription did not connect in time."); }
            }
            receive = ReceiveAsync(transport, token);
            send = SendAsync(transport, token);
            if (await Task.WhenAny(send, receive).ConfigureAwait(false) == receive)
            {
                // Observe provider failures promptly while capture is still active.
                await receive.ConfigureAwait(false);
                if (Volatile.Read(ref inputSent) == 0)
                    throw new InvalidDataException("Streaming provider completed before all audio was sent.");
            }
            await send.ConfigureAwait(false);
            string text;
            using (metrics.Measure("Finalize streaming transcript"))
                try { text = await receive.WaitAsync(finishTimeout, token).ConfigureAwait(false); }
                catch (TimeoutException) { throw new TimeoutException("Streaming provider did not return the completed transcript in time."); }
            if (string.IsNullOrWhiteSpace(text)) throw new InvalidDataException("Streaming provider returned no transcript.");
            callerToken.ThrowIfCancellationRequested();
            Interlocked.Exchange(ref completed, 1);
            metrics.Cost("voice", protocol.Model, Volatile.Read(ref audioBytes) / 32000m / 3600m * protocol.PricePerHour);
            return text;
        }
        catch (Exception ex)
        {
            if (callerToken.IsCancellationRequested) throw new OperationCanceledException(callerToken);
            var safe = Failure ?? (ex is HttpRequestException or InvalidDataException or TimeoutException
                ? ex : new HttpRequestException("Streaming transcription failed. Check your key, credit and connection."));
            Interlocked.CompareExchange(ref failure, safe, null);
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(safe).Throw();
            throw;
        }
        finally
        {
            lifetime.Cancel();
            audio.Writer.TryComplete();
            while (audio.Reader.TryRead(out _)) { }
            // No abandoned receive operation may survive into the next recording.
            if (send is not null) try { await send.ConfigureAwait(false); } catch { }
            if (receive is not null) try { await receive.ConfigureAwait(false); } catch { }
            lifetime.Dispose();
        }
    }
    private async Task SendAsync(IStreamingTransport transport, CancellationToken token)
    {
        using var stage = metrics.Measure("Stream audio");
        var frame = new byte[protocol.FrameBytes];
        var filled = 0;
        await foreach (var chunk in audio.Reader.ReadAllAsync(token).ConfigureAwait(false))
        {
            var offset = 0;
            while (offset < chunk.Length)
            {
                var bytes = Math.Min(frame.Length - filled, chunk.Length - offset);
                chunk.AsSpan(offset, bytes).CopyTo(frame.AsSpan(filled));
                offset += bytes; filled += bytes;
                if (filled != frame.Length) continue;
                await transport.SendAsync(frame, false, token).ConfigureAwait(false);
                metrics.RequestSize(frame.Length); filled = 0;
            }
            Interlocked.Add(ref queuedBytes, -chunk.Length);
        }
        if (filled > 0)
        {
            await transport.SendAsync(frame.AsMemory(0, filled), false, token).ConfigureAwait(false);
            metrics.RequestSize(filled);
        }
        Interlocked.Exchange(ref inputSent, 1);
        await protocol.CompleteInputAsync(transport, token).ConfigureAwait(false);
    }
    private async Task<string> ReceiveAsync(IStreamingTransport transport, CancellationToken token)
    {
        while (true)
        {
            using var message = await transport.ReceiveAsync(token).ConfigureAwait(false);
            var update = protocol.Read(message);
            if (update.Transcript) metrics.FirstTranscript();
            if (update.Completed)
            {
                if (Volatile.Read(ref inputSent) == 0)
                    throw new InvalidDataException("Streaming provider completed before all audio was sent.");
                return update.Text ?? "";
            }
        }
    }
}
