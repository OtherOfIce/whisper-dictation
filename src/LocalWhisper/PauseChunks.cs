namespace LocalWhisper;

// Mono 16-bit PCM at 16 kHz. Split only at pauses, never forcibly inside a word.
internal sealed class PauseChunks
{
    private readonly MemoryStream pending = new();
    private double quietSeconds;
    public byte[]? Add(byte[] pcm, int count, float peak)
    {
        pending.Write(pcm, 0, count);
        quietSeconds = peak < .012f ? quietSeconds + count / 32000d : 0;
        return pending.Length >= 6 * 32000 && quietSeconds >= .45 ? Drain() : null;
    }
    public byte[] Drain()
    {
        var result = pending.ToArray(); pending.SetLength(0); quietSeconds = 0; return result;
    }
}
