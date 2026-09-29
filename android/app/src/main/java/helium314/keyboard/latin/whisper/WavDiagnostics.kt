package helium314.keyboard.latin.whisper

import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.sqrt

data class WavMeasurements(
    val sampleRate: Int, val channels: Int, val bitsPerSample: Int,
    val pcmBytes: Long, val durationSeconds: Double, val headerMatchesFile: Boolean,
    val peakDbfs: Double, val rmsDbfs: Double, val clippedPercent: Double, val quietFramesPercent: Double,
)

object WavDiagnostics {
    fun measure(file: File): WavMeasurements = RandomAccessFile(file, "r").use { input ->
        val header = ByteArray(44).also(input::readFully)
        val bytes = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN)
        fun label(offset: Int) = String(header, offset, 4, Charsets.US_ASCII)
        require(label(0) == "RIFF" && label(8) == "WAVE" && label(12) == "fmt " && label(36) == "data" && bytes.getInt(16) == 16 && bytes.getShort(20).toInt() == 1) { "Unexpected WAV format" }
        val channels = bytes.getShort(22).toInt()
        val rate = bytes.getInt(24)
        val bits = bytes.getShort(34).toInt()
        require(channels == 1 && rate > 0 && bits == 16) { "Expected mono PCM16 WAV" }
        val pcmBytes = input.length() - 44
        require(pcmBytes > 0 && pcmBytes % 2 == 0L) { "Empty or incomplete PCM audio" }
        var samples = 0L; var clipped = 0L; var peak = 0
        var sumSquares = 0.0; var frameSquares = 0.0; var frameSamples = 0
        var quietFrames = 0L; var frames = 0L
        val frameSize = maxOf(1, rate / 50)
        fun finishFrame() {
            if (frameSamples == 0) return
            frames++
            if (sqrt(frameSquares / frameSamples) / 32768 < 0.0031623) quietFrames++
            frameSquares = 0.0; frameSamples = 0
        }
        val buffer = ByteArray(8192)
        while (input.filePointer < input.length()) {
            val count = minOf(buffer.size.toLong(), input.length() - input.filePointer).toInt()
            input.readFully(buffer, 0, count)
            for (offset in 0 until count step 2) {
                val sample = ((buffer[offset].toInt() and 255) or (buffer[offset + 1].toInt() shl 8)).toShort().toInt()
                val amplitude = abs(sample)
                peak = maxOf(peak, amplitude)
                if (amplitude >= 32760) clipped++
                val square = sample.toDouble() * sample
                sumSquares += square; frameSquares += square; samples++; frameSamples++
                if (frameSamples == frameSize) finishFrame()
            }
        }
        finishFrame()
        fun db(value: Double) = if (value <= 0) -120.0 else 20 * log10(value / 32768)
        WavMeasurements(rate, channels, bits, pcmBytes, samples.toDouble() / rate,
            bytes.getInt(40).toLong() == pcmBytes && bytes.getInt(4).toLong() == input.length() - 8,
            db(peak.toDouble()), db(sqrt(sumSquares / samples)), clipped * 100.0 / samples, quietFrames * 100.0 / frames)
    }
}
