package helium314.keyboard.latin.whisper

import org.junit.Assert.*
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.file.Files

class WavDiagnosticsTest {
    @Test fun detectsSilenceClippingAndDuration() {
        val file = Files.createTempFile("whisper-audio", ".wav").toFile()
        try {
            val pcm = ByteBuffer.allocate(32000).order(ByteOrder.LITTLE_ENDIAN)
            repeat(8000) { pcm.putShort(0) }
            repeat(8000) { pcm.putShort(32767) }
            file.writeBytes(AudioRecordingSpec.wavHeader(pcm.capacity()) + pcm.array())
            val result = WavDiagnostics.measure(file)
            assertEquals(1.0, result.durationSeconds, 0.0001)
            assertEquals(50.0, result.clippedPercent, 0.001)
            assertEquals(50.0, result.quietFramesPercent, 0.001)
            assertEquals(-3.01, result.rmsDbfs, 0.01)
            assertEquals(0.0, result.peakDbfs, 0.001)
            assertTrue(result.headerMatchesFile)
            file.writeBytes(AudioRecordingSpec.wavHeader(0) + pcm.array())
            assertFalse(WavDiagnostics.measure(file).headerMatchesFile)
        } finally { file.delete() }
    }
    @Test fun silentAudioHasFiniteMeasurements() {
        val file = Files.createTempFile("whisper-silent", ".wav").toFile()
        try {
            file.writeBytes(AudioRecordingSpec.wavHeader(640) + ByteArray(640))
            val result = WavDiagnostics.measure(file)
            assertEquals(-120.0, result.rmsDbfs, 0.001)
            assertEquals(100.0, result.quietFramesPercent, 0.001)
        } finally { file.delete() }
    }
}
