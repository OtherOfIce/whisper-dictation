using NAudio.Wave;
using NAudio.MediaFoundation;

namespace LocalWhisper;

internal static class AudioEncoding
{
    public static (byte[] Bytes, string Format) Compress(byte[] wav)
    {
        MediaFoundationApi.Startup();
        using var input = new WaveFileReader(new MemoryStream(wav));
        using var output = new MemoryStream();
        MediaFoundationEncoder.EncodeToMp3(input, output, 48000);
        return (output.ToArray(), "mp3");
    }
}
