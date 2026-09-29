package helium314.keyboard.latin.whisper

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.util.UUID
import kotlin.concurrent.thread

private const val TAG = "AudioRecorder"

class AudioRecorder(private val context: Context) {
    private var recorder: AudioRecord? = null
    private var outputFile: File? = null
    private var writerThread: Thread? = null
    @Volatile private var writerRunning = false
    @Volatile private var captureStartedMs = 0L
    @Volatile private var captureError: String? = null
    private var captureInfo: JSONObject? = null
    fun captureMetadata(): JSONObject? = captureInfo?.let { JSONObject(it.toString()) }
    val isActive: Boolean get() = recorder != null

    @SuppressLint("MissingPermission")
    @Synchronized
    fun start(): Boolean {
        if (isActive) return true
        cancel()
        val minimumBuffer = AudioRecord.getMinBufferSize(
            AudioRecordingSpec.SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minimumBuffer <= 0) return false
        val bufferSize = maxOf(minimumBuffer, AudioRecordingSpec.SAMPLE_RATE / 5 * 2)
        val file = File(context.cacheDir, "dictation-${UUID.randomUUID()}.${AudioRecordingSpec.FILE_EXTENSION}")
        val audioRecord = try {
            AudioRecord(
                MediaRecorder.AudioSource.MIC,
                AudioRecordingSpec.SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufferSize,
            )
        } catch (error: Exception) {
            Log.e(TAG, "Could not create microphone recorder", error)
            return false
        }
        if (audioRecord.state != AudioRecord.STATE_INITIALIZED) {
            audioRecord.release()
            return false
        }

        var pendingOutput: RandomAccessFile? = null
        return try {
            val wavOutput = RandomAccessFile(file, "rw")
            pendingOutput = wavOutput
            wavOutput.setLength(0)
            wavOutput.write(AudioRecordingSpec.wavHeader(0))
            audioRecord.startRecording()
            if (audioRecord.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                wavOutput.close()
                pendingOutput = null
                audioRecord.release()
                file.delete()
                return false
            }
            recorder = audioRecord
            captureStartedMs = SystemClock.elapsedRealtime()
            captureError = null
            captureInfo = JSONObject().put("source", "MIC").put("requestedSampleRate", AudioRecordingSpec.SAMPLE_RATE)
                .put("reportedSampleRate", audioRecord.sampleRate).put("reportedChannels", audioRecord.channelCount)
                .put("bufferBytes", bufferSize)
            if (android.os.Build.VERSION.SDK_INT >= 23) {
                audioRecord.routedDevice?.let { captureInfo?.put("inputDeviceType", it.type)?.put("inputDeviceName", it.productName.toString()) }
            }
            outputFile = file
            writerRunning = true
            writerThread = thread(name = "WhisperWavWriter") {
                writePcm(audioRecord, wavOutput, bufferSize)
            }
            pendingOutput = null
            true
        } catch (error: Exception) {
            Log.e(TAG, "Could not start microphone recorder", error)
            runCatching { pendingOutput?.close() }
            runCatching { audioRecord.release() }
            file.delete()
            false
        }
    }

    @Synchronized
    fun stop(): File? {
        val current = recorder ?: return null
        val file = outputFile
        recorder = null
        outputFile = null
        stopWriter(current)
        return file?.takeIf { it.isFile && it.length() > 44L } ?: run {
            file?.delete()
            null
        }
    }

    @Synchronized
    fun cancel() {
        val current = recorder
        recorder = null
        if (current != null) stopWriter(current)
        outputFile?.delete()
        outputFile = null
    }

    private fun stopWriter(current: AudioRecord) {
        writerRunning = false
        runCatching { current.stop() }
        val writer = writerThread
        writerThread = null
        if (writer != null && writer !== Thread.currentThread()) runCatching { writer.join(2_000) }
        captureInfo?.put("captureElapsedMs", SystemClock.elapsedRealtime() - captureStartedMs)
            ?.put("writerFinished", writer?.isAlive != true)
        captureError?.let { captureInfo?.put("readErrorType", it) }
        runCatching { current.release() }
    }

    private fun writePcm(audioRecord: AudioRecord, output: RandomAccessFile, bufferSize: Int) {
        val buffer = ByteArray(bufferSize)
        var pcmBytes = 0
        try {
            while (writerRunning && pcmBytes < AudioRecordingSpec.MAX_PCM_BYTES) {
                val requested = minOf(buffer.size, AudioRecordingSpec.MAX_PCM_BYTES - pcmBytes)
                val read = audioRecord.read(buffer, 0, requested)
                if (read > 0) {
                    output.write(buffer, 0, read)
                    pcmBytes += read
                } else if (read != 0 && writerRunning) {
                    throw IllegalStateException("AudioRecord read failed: $read")
                }
            }
        } catch (error: Exception) {
            captureError = error.javaClass.simpleName
            if (writerRunning) Log.e(TAG, "Could not record microphone audio", error)
        } finally {
            writerRunning = false
            runCatching {
                output.seek(0)
                output.write(AudioRecordingSpec.wavHeader(pcmBytes))
            }
            runCatching { output.close() }
        }
    }
}
