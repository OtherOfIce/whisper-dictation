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
    private var job: Job? = null
    private var recordingFile: File? = null
    private var operationId = 0L
    private var editorSessionToken = -1L
    private var secureInput = true
    private var transcribing = false
    private val vibrator: Vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
    } else {
        @Suppress("DEPRECATION")
        context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
    }

    val isRecording get() = recorder.isActive
    var onTranscriptionResult: ((TranscriptionResult) -> Unit)? = null
    var onStateChanged: ((RecordingState) -> Unit)? = null
    enum class RecordingState { IDLE, RECORDING, TRANSCRIBING }

    fun onEditorSessionChanged(token: Long, isSecureInput: Boolean) { cancelCurrent(); editorSessionToken = token; secureInput = isSecureInput }
    fun toggleRecording() { if (recorder.isActive) releaseRecord() else if (transcribing) cancelCurrent(true) else pressRecord() }

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
        val requestOperation = operationId
        val requestSession = editorSessionToken
        val apiKey = credentials.load()
        if (apiKey.isNullOrBlank()) { file.delete(); recordingFile = null; onStateChanged?.invoke(RecordingState.IDLE); return }
        val prefs = context.prefs()
        val language = prefs.getString(Settings.PREF_WHISPER_LANGUAGE, Defaults.PREF_WHISPER_LANGUAGE) ?: "auto"
        val dictionary = DictionaryLimits.validate(prefs.getString(Settings.PREF_WHISPER_DICTIONARY, "").orEmpty())
        if (dictionary.error != null) Toast.makeText(context, "Preferred terms are invalid; continuing without hints", Toast.LENGTH_LONG).show()
        val keywords = dictionary.keywords
        transcribing = true; onStateChanged?.invoke(RecordingState.TRANSCRIBING)
        job = scope.launch {
            try {
                val text = client.transcribe(file, apiKey, language, keywords)
                if (operationId == requestOperation && editorSessionToken == requestSession && text.isNotBlank())
                    onTranscriptionResult?.invoke(TranscriptionResult(text, requestSession))
            } catch (_: CancellationException) {
            } catch (error: Exception) {
                Log.e(TAG, "Transcription request failed: ${error.javaClass.simpleName}")
                if (operationId == requestOperation) Toast.makeText(context, "Transcription failed", Toast.LENGTH_SHORT).show()
            } finally {
                file.delete()
                if (operationId == requestOperation) { recordingFile = null; job = null; transcribing = false; onStateChanged?.invoke(RecordingState.IDLE) }
            }
        }
    }

    fun cancelCurrent(showMessage: Boolean = false) {
        val wasActive = recorder.isActive || transcribing
        operationId++; recorder.cancel(); client.cancel(); job?.cancel(); job = null
        recordingFile?.delete(); recordingFile = null; transcribing = false
        onStateChanged?.invoke(RecordingState.IDLE)
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
}
