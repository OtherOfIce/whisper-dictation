package helium314.keyboard.latin.whisper

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import android.widget.Toast
import androidx.core.content.ContextCompat
import helium314.keyboard.latin.settings.Defaults
import helium314.keyboard.latin.settings.Settings
import helium314.keyboard.latin.utils.prefs
import kotlinx.coroutines.*
import java.io.File

private const val TAG = "WhisperManager"
data class TranscriptionResult(val text: String, val editorSessionToken: Long)

class WhisperManager(private val context: Context) {
    private val recorder = AudioRecorder(context)
    private val client = OpenRouterClient()
    private val credentials = SecureCredentialStore(context)
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    init {
        scope.launch {
            while (isActive) { DictionarySync.sync(context.applicationContext); delay(60_000) }
        }
    }
    private var job: Job? = null
    private var recordingFile: File? = null
    private val failedRecording = File(context.noBackupFilesDir, "failed-dictation.wav")
    private var operationId = 0L
    private var editorSessionToken = -1L
    private var secureInput = true
    private var transcribing = false
    private var cleaning = false
    private val vibrator: Vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
    } else {
        @Suppress("DEPRECATION")
        context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
    }

    val isRecording get() = recorder.isActive
    val recordingState get() = when {
        recorder.isActive -> RecordingState.RECORDING
        cleaning -> RecordingState.CLEANING
        transcribing -> RecordingState.TRANSCRIBING
        failedRecording.isFile -> RecordingState.RETRY_READY
        else -> RecordingState.IDLE
    }
    var onTranscriptionResult: ((TranscriptionResult) -> Unit)? = null
    var onStateChanged: ((RecordingState) -> Unit)? = null
    enum class RecordingState { IDLE, RECORDING, TRANSCRIBING, CLEANING, RETRY_READY }

    fun onEditorSessionChanged(token: Long, isSecureInput: Boolean) { cancelCurrent(); editorSessionToken = token; secureInput = isSecureInput }
    fun toggleRecording() {
        when {
            recorder.isActive -> releaseRecord()
            transcribing -> cancelCurrent(true)
            failedRecording.isFile -> retryFailed()
            else -> pressRecord()
        }
    }

    fun pressRecord() {
        if (transcribing) { cancelCurrent(true); return }
        if (recorder.isActive) return
        val message = when {
            secureInput -> "Voice input is disabled for secure fields"
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED -> "Grant microphone access in Local Whisper Keyboard settings"
            !credentials.isAvailable() -> "Unlock the device before using voice input"
            !credentials.hasKey() -> "Add an OpenRouter API key in keyboard settings"
            else -> null
        }
        if (message != null) { Toast.makeText(context, message, Toast.LENGTH_LONG).show(); return }
        operationId++
        if (!recorder.start()) { Toast.makeText(context, "Microphone unavailable", Toast.LENGTH_SHORT).show(); return }
        vibrate(50); onStateChanged?.invoke(RecordingState.RECORDING)
    }

    fun releaseRecord() {
        if (!recorder.isActive) return
        vibrate(100)
        val file = recorder.stop()
        if (file == null) { onStateChanged?.invoke(RecordingState.IDLE); return }
        recordingFile = file
        startTranscription(file, false)
    }

    private fun retryFailed() {
        if (secureInput) {
            Toast.makeText(context, "Voice input is disabled for secure fields", Toast.LENGTH_LONG).show()
            return
        }
        operationId++
        startTranscription(failedRecording, true)
    }

    private fun startTranscription(file: File, retry: Boolean) {
        val requestOperation = operationId
        val requestSession = editorSessionToken
        val apiKey = credentials.load()
        if (apiKey.isNullOrBlank()) {
            if (!retry) {
                retainFailed(file)
                file.delete()
                recordingFile = null
            }
            Toast.makeText(context, "Add an OpenRouter API key to retry", Toast.LENGTH_LONG).show()
            onStateChanged?.invoke(recordingState)
            return
        }
        val prefs = context.prefs()
        val language = prefs.getString(Settings.PREF_WHISPER_LANGUAGE, Defaults.PREF_WHISPER_LANGUAGE) ?: "auto"
        val transcriptionModel = prefs.getString(Settings.PREF_WHISPER_TRANSCRIPTION_MODEL, Defaults.PREF_WHISPER_TRANSCRIPTION_MODEL)
            ?: Defaults.PREF_WHISPER_TRANSCRIPTION_MODEL
        val dictionary = DictionaryLimits.validate(prefs.getString(Settings.PREF_WHISPER_DICTIONARY, "").orEmpty())
        if (dictionary.error != null) Toast.makeText(context, "Preferred terms are invalid; continuing without hints", Toast.LENGTH_LONG).show()
        val keywords = dictionary.keywords
        val raceMai = prefs.getBoolean(PREF_RACE_MAI, true)
        val cleanup = prefs.getBoolean(PREF_LUNA_CLEANUP, false)
        transcribing = true; onStateChanged?.invoke(RecordingState.TRANSCRIBING)
        job = scope.launch {
            var succeeded = false
            try {
                val raw = client.transcribeWithFallback(file, apiKey, language, keywords, transcriptionModel, raceMai)
                if (cleanup) {
                    cleaning = true
                    onStateChanged?.invoke(RecordingState.CLEANING)
                }
                val text = if (cleanup) try { client.clean(raw, apiKey) } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    Log.w(TAG, "Luna cleanup failed; inserting original transcript", error)
                    withContext(Dispatchers.Main) {
                        Toast.makeText(context, "Cleanup failed; using original transcript", Toast.LENGTH_SHORT).show()
                    }
                    raw
                } else raw
                if (operationId == requestOperation && editorSessionToken == requestSession) {
                    onTranscriptionResult?.invoke(TranscriptionResult(text, requestSession))
                    succeeded = true
                }
            } catch (_: CancellationException) {
            } catch (error: Exception) {
                Log.e(TAG, "Transcription request failed: ${error.javaClass.simpleName}: ${error.message}")
                if (operationId == requestOperation) {
                    if (!retry) retainFailed(file)
                    Toast.makeText(context, "Transcription failed. Tap the microphone to retry.", Toast.LENGTH_LONG).show()
                }
            } finally {
                if (succeeded) failedRecording.delete()
                if (!retry) file.delete()
                if (operationId == requestOperation) {
                    recordingFile = null; job = null; transcribing = false; cleaning = false
                    onStateChanged?.invoke(recordingState)
                }
            }
        }
    }

    private fun retainFailed(file: File) {
        try {
            if (file != failedRecording) file.copyTo(failedRecording, overwrite = true)
        } catch (error: Exception) {
            Log.e(TAG, "Could not retain failed recording", error)
            Toast.makeText(context, "Could not save the failed recording", Toast.LENGTH_LONG).show()
        }
    }

    fun cancelCurrent(showMessage: Boolean = false) {
        val wasActive = recorder.isActive || transcribing
        operationId++; recorder.cancel(); job?.cancel(); job = null
        recordingFile?.delete(); recordingFile = null; transcribing = false; cleaning = false
        onStateChanged?.invoke(recordingState)
        if (showMessage && wasActive) Toast.makeText(context, "Voice input cancelled", Toast.LENGTH_SHORT).show()
    }

    private fun vibrate(ms: Long) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
        } else {
            @Suppress("DEPRECATION")
            vibrator.vibrate(ms)
        }
    }
    fun release() { cancelCurrent(); scope.cancel() }

    companion object {
        const val PREF_RACE_MAI = "whisper_race_mai"
        const val PREF_LUNA_CLEANUP = "whisper_luna_cleanup"
        fun failedRecording(context: Context) = File(context.noBackupFilesDir, "failed-dictation.wav")
    }
}
