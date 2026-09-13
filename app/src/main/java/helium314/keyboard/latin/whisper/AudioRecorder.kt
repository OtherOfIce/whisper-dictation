package helium314.keyboard.latin.whisper

import android.annotation.SuppressLint
import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import android.util.Log
import java.io.File
import java.util.UUID

private const val TAG = "AudioRecorder"

class AudioRecorder(private val context: Context) {
    private var recorder: MediaRecorder? = null
    private var outputFile: File? = null
    @Volatile private var autoStopped = false
    val isActive: Boolean get() = recorder != null

    @SuppressLint("MissingPermission")
    fun start(): Boolean {
        if (isActive) return true
        cancel()
        autoStopped = false
        val file = File(context.cacheDir, "dictation-${UUID.randomUUID()}.m4a")
        val mediaRecorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(context) else {
            @Suppress("DEPRECATION")
            MediaRecorder()
        }
        return try {
            mediaRecorder.setAudioSource(MediaRecorder.AudioSource.MIC)
            mediaRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            mediaRecorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            mediaRecorder.setAudioChannels(1)
            mediaRecorder.setAudioSamplingRate(16_000)
            mediaRecorder.setAudioEncodingBitRate(48_000)
            mediaRecorder.setMaxDuration(300_000)
            mediaRecorder.setMaxFileSize(4L * 1024L * 1024L)
            mediaRecorder.setOnInfoListener { _, what, _ ->
                if (recorder === mediaRecorder &&
                    (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED ||
                        what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED)) autoStopped = true
            }
            mediaRecorder.setOutputFile(file.absolutePath)
            mediaRecorder.prepare()
            mediaRecorder.start()
            outputFile = file
            recorder = mediaRecorder
            true
        } catch (error: Exception) {
            Log.e(TAG, "Could not start microphone recorder", error)
            runCatching { mediaRecorder.release() }
            file.delete()
            false
        }
    }

    fun stop(): File? {
        val current = recorder ?: return null
        val file = outputFile
        recorder = null
        outputFile = null
        return try {
            if (!autoStopped) current.stop()
            file?.takeIf { it.isFile && it.length() > 0L }
        } catch (error: RuntimeException) {
            Log.w(TAG, "Recording was too short or interrupted", error)
            file?.delete()
            null
        } finally {
            current.setOnInfoListener(null)
            runCatching { current.release() }
        }
    }

    fun cancel() {
        val current = recorder
        recorder = null
        if (current != null) {
            current.setOnInfoListener(null)
            runCatching { current.stop() }
            runCatching { current.release() }
        }
        outputFile?.delete()
        outputFile = null
        autoStopped = false
    }
}
