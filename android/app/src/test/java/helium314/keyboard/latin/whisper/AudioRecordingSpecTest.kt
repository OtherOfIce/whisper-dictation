package helium314.keyboard.latin.whisper

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.test.Test
import kotlin.test.assertEquals

class AudioRecordingSpecTest {
    @Test
    fun `records a format accepted by MAI Transcribe 2`() {
        assertEquals("wav", AudioRecordingSpec.FILE_EXTENSION)
        assertEquals("wav", AudioRecordingSpec.API_FORMAT)
    }

    @Test
    fun `wav header describes the recorded PCM data`() {
        val pcmBytes = 32_000
        val header = AudioRecordingSpec.wavHeader(pcmBytes)
        assertEquals("RIFF", header.copyOfRange(0, 4).toString(Charsets.US_ASCII))
        assertEquals("WAVE", header.copyOfRange(8, 12).toString(Charsets.US_ASCII))
        assertEquals("data", header.copyOfRange(36, 40).toString(Charsets.US_ASCII))
        assertEquals(pcmBytes, ByteBuffer.wrap(header, 40, 4).order(ByteOrder.LITTLE_ENDIAN).int)
    }
}
