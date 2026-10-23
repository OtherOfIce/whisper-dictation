package helium314.keyboard.latin.whisper

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
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
import java.io.IOException
import org.json.JSONObject

private const val TAG = "WhisperManager"
data class TranscriptionResult(val text: String, val editorSessionToken: Long)

class WhisperManager @JvmOverloads constructor(
    private val context: Context,
    private val recorder: AudioRecorder = AudioRecorder(context),
    private val client: OpenRouterClient = OpenRouterClient(),
    private val credentials: SecureCredentialStore = SecureCredentialStore(context),
    private val gatewayCredentials: SecureCredentialStore = SecureCredentialStore(context, "gateway"),
    private val streamingFactory: (String, String) -> GatewayStreamingSession = { key, language -> GatewayStreamingSession(key, language) },
) {
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    init {
        scope.launch {
            while (isActive) { Account.syncAll(context.applicationContext); delay(60_000) }
        }
    }
    private var job: Job? = null
    private var recordingFile: File? = null
    private var liveSession: GatewayStreamingSession? = null
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
            !credentials.hasKey() && streamingKey() == null -> "Add an OpenRouter API key in keyboard settings"
            else -> null
        }
        if (message != null) { Toast.makeText(context, message, Toast.LENGTH_LONG).show(); return }
        operationId++
        // Live MAI starts streaming as soon as recording does; the recording is still kept for fallback and retry.
        val session = streamingKey()?.let { key -> runCatching { streamingFactory(key, language()) }.getOrNull() }
        if (!recorder.start(session?.let { it::send })) {
            session?.cancel()
            Toast.makeText(context, "Microphone unavailable", Toast.LENGTH_SHORT).show(); return
        }
        liveSession = session
        if (context.prefs().getBoolean(DictationAudioService.PREF_PAUSE_MEDIA, true)) DictationAudioService.start(context)
        vibrate(50); onStateChanged?.invoke(RecordingState.RECORDING)
    }

    fun releaseRecord() {
        if (!recorder.isActive) return
        vibrate(100)
        val file = recorder.stop()
        if (file == null) { DictationAudioService.stop(context); onStateChanged?.invoke(RecordingState.IDLE); return }
        recordingFile = file
        val session = liveSession; liveSession = null
        startTranscription(file, false, session)
    }

    private fun language() = context.prefs().getString(Settings.PREF_WHISPER_LANGUAGE, Defaults.PREF_WHISPER_LANGUAGE) ?: "auto"
    private fun selectedModel() = context.prefs().getString(Settings.PREF_WHISPER_TRANSCRIPTION_MODEL, Defaults.PREF_WHISPER_TRANSCRIPTION_MODEL)
        ?: Defaults.PREF_WHISPER_TRANSCRIPTION_MODEL
    /** The Vercel AI Gateway key, when live MAI is selected and one is saved. */
    private fun streamingKey(): String? =
        if (selectedModel() == GatewayStreamingSession.MODEL) gatewayCredentials.load()?.takeIf { it.isNotBlank() } else null

    private fun retryFailed() {
        if (secureInput) {
            Toast.makeText(context, "Voice input is disabled for secure fields", Toast.LENGTH_LONG).show()
            return
        }
        operationId++
        startTranscription(failedRecording, true)
    }

    private fun startTranscription(file: File, retry: Boolean, live: GatewayStreamingSession? = null) {
        val requestOperation = operationId
        val requestSession = editorSessionToken
        val apiKey = credentials.load()?.takeIf { it.isNotBlank() }
        val gatewayKey = streamingKey()
        if (apiKey == null && gatewayKey == null) {
            live?.cancel()
            if (retry) {
                failedRecording.delete()
            } else {
                retainFailed(file)
                file.delete()
                recordingFile = null
            }
            DictationAudioService.stop(context)
            Toast.makeText(context, "Add an OpenRouter API key to retry", Toast.LENGTH_LONG).show()
            onStateChanged?.invoke(recordingState)
            return
        }
        val prefs = context.prefs()
        val language = language()
        val transcriptionModel = selectedModel()
        val dictionary = DictionaryLimits.validate(prefs.getString(Settings.PREF_WHISPER_DICTIONARY, "").orEmpty())
        if (dictionary.error != null) Toast.makeText(context, "Preferred terms are invalid; continuing without hints", Toast.LENGTH_LONG).show()
        val keywords = dictionary.keywords
        val raceMai = prefs.getBoolean(PREF_RACE_MAI, true)
        val cleanup = prefs.getBoolean(PREF_LUNA_CLEANUP, false) && apiKey != null
        val logStore = if (RecordingLogStore.enabled(context)) RecordingLogStore.forContext(context) else null
        val capture = if (retry) null else recorder.captureMetadata()
        transcribing = true; onStateChanged?.invoke(RecordingState.TRANSCRIBING)
        job = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            var succeeded = false
            var logId: String? = null
            var rawTranscript: String? = null
            var finalTranscript: String? = null
            var outcome = "Cancelled"
            var errorType: String? = null
            val route = JSONObject()
            val started = SystemClock.elapsedRealtime()
            try {
                if (logStore != null) withContext(NonCancellable + Dispatchers.IO) {
                    runCatching {
                        val metadata = JSONObject().put("requestedModel", transcriptionModel).put("language", language)
                            .put("dictionaryTermCount", keywords.size).put("raceMai", raceMai).put("cleanupEnabled", cleanup).put("manualRetry", retry)
                        if (capture != null) metadata.put("capture", capture)
                        logId = logStore.begin(file, metadata)
                    }.onFailure { Log.w(TAG, "[DEBUG-audio] Could not save recording diagnostics") }
                }
                ensureActive()
                val raw = transcribe(file, apiKey, gatewayKey, live, language, keywords, transcriptionModel, raceMai, route)
                rawTranscript = raw
                if (cleanup) {
                    cleaning = true
                    onStateChanged?.invoke(RecordingState.CLEANING)
                }
                val text = if (cleanup) try { client.clean(raw, apiKey!!, keywords) } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    Log.w(TAG, "Luna cleanup failed; inserting original transcript", error)
                    withContext(Dispatchers.Main) {
                        Toast.makeText(context, "Cleanup failed; using original transcript", Toast.LENGTH_SHORT).show()
                    }
                    raw
                } else raw
                finalTranscript = text
                if (operationId == requestOperation && editorSessionToken == requestSession) {
                    onTranscriptionResult?.invoke(TranscriptionResult(text, requestSession))
                    succeeded = true
                    outcome = "Transcribed"
                } else outcome = "Editor changed"
            } catch (_: CancellationException) {
            } catch (error: Exception) {
                outcome = "Failed"
                errorType = error.javaClass.simpleName
                Log.e(TAG, "Transcription request failed: ${error.javaClass.simpleName}: ${error.message}")
                if (operationId == requestOperation) {
                    if (retry) failedRecording.delete() else retainFailed(file)
                    val message = if (failedRecording.isFile)
                        "Transcription failed. Tap to retry; tap again to cancel and record again."
                    else "Transcription failed. Tap the microphone to record again."
                    Toast.makeText(context, message, Toast.LENGTH_LONG).show()
                }
            } finally {
                withContext(NonCancellable + Dispatchers.IO) {
                    logId?.let { id -> runCatching { logStore?.finish(id, outcome, rawTranscript, finalTranscript, SystemClock.elapsedRealtime() - started, errorType, route) }
                        .onFailure { Log.w(TAG, "[DEBUG-audio] Could not finish recording diagnostics") } }
                }
                live?.cancel()
                if (succeeded) failedRecording.delete()
                if (!retry) file.delete()
                if (operationId == requestOperation) {
                    DictationAudioService.stop(context)
                    recordingFile = null; job = null; transcribing = false; cleaning = false
                    onStateChanged?.invoke(recordingState)
                }
            }
        }
    }

    /**
     * Live MAI uses the session that streamed during recording (or streams a saved recording on retry). If it fails,
     * the recording goes to MAI Clean and then GPT-Transcribe through OpenRouter, as on the desktop.
     */
    private suspend fun transcribe(file: File, apiKey: String?, gatewayKey: String?, live: GatewayStreamingSession?, language: String,
                                   keywords: List<String>, model: String, raceMai: Boolean, route: JSONObject): String {
        if (model != GatewayStreamingSession.MODEL) {
            route.put("usedModel", model)
            return client.transcribeWithFallback(file, apiKey ?: throw IOException("No OpenRouter API key"), language, keywords, model, raceMai)
        }
        if (gatewayKey != null) {
            try {
                val session = live ?: withContext(Dispatchers.IO) { streamingFactory(gatewayKey, language).also { it.replay(file) } }
                route.put("usedModel", model).put("live", live != null)
                return session.finish()
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                Log.w(TAG, "Live MAI failed; using the recording instead: ${error.message}")
                route.put("streamingError", error.message ?: error.javaClass.simpleName)
            }
        } else route.put("streamingError", "No Vercel AI Gateway key")
        route.put("usedModel", "mai-transcribe-2-clean")
        return client.transcribeWithFallback(file, apiKey ?: throw IOException("No OpenRouter API key for the fallback"), language, keywords, "mai-transcribe-2-clean", raceMai)
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
        operationId++; recorder.cancel()
        DictationAudioService.stop(context)
        liveSession?.cancel(); liveSession = null
        val activeJob = job
        activeJob?.cancel(); job = null
        if (activeJob == null) recordingFile?.delete()
        recordingFile = null; transcribing = false; cleaning = false
        // An explicit microphone tap cancels the saved retry too. Lifecycle changes keep it.
        if (showMessage) failedRecording.delete()
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
