package helium314.keyboard.latin.whisper

import java.nio.ByteBuffer
import java.nio.ByteOrder

internal object AudioRecordingSpec {
    const val FILE_EXTENSION = "wav"
    const val API_FORMAT = "wav"
    const val SAMPLE_RATE = 16_000
    const val CHANNELS = 1
    const val BITS_PER_SAMPLE = 16
    const val MAX_DURATION_SECONDS = 300
    const val MAX_PCM_BYTES = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8) * MAX_DURATION_SECONDS

    fun wavHeader(pcmBytes: Int): ByteArray = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN).apply {
        put("RIFF".toByteArray(Charsets.US_ASCII))
        putInt(36 + pcmBytes)
        put("WAVE".toByteArray(Charsets.US_ASCII))
        put("fmt ".toByteArray(Charsets.US_ASCII))
        putInt(16)
        putShort(1)
        putShort(CHANNELS.toShort())
        putInt(SAMPLE_RATE)
        putInt(SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8))
        putShort((CHANNELS * (BITS_PER_SAMPLE / 8)).toShort())
        putShort(BITS_PER_SAMPLE.toShort())
        put("data".toByteArray(Charsets.US_ASCII))
        putInt(pcmBytes)
    }.array()
}
