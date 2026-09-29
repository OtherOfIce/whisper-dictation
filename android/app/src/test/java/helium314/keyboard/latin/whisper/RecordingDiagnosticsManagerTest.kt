package helium314.keyboard.latin.whisper

import android.app.Application
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import helium314.keyboard.latin.utils.prefs
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.Mockito.*
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class)
class RecordingDiagnosticsManagerTest {
    private val context = ApplicationProvider.getApplicationContext<Application>()
    private val root get() = File(context.noBackupFilesDir, "recording-diagnostics")
    private var manager: WhisperManager? = null
    @After fun clean() {
        manager?.release()
        root.deleteRecursively()
        context.prefs().edit().remove(RecordingLogStore.PREF_ENABLED).commit()
        WhisperManager.failedRecording(context).delete()
    }
    private fun dictate(enabled: Boolean): ByteArray {
        context.prefs().edit().putBoolean(RecordingLogStore.PREF_ENABLED, enabled).commit()
        val bytes = AudioRecordingSpec.wavHeader(640) + ByteArray(640)
        val source = File(context.cacheDir, "diagnostic-test.wav").apply { writeBytes(bytes) }
        val recorder = mock(AudioRecorder::class.java)
        `when`(recorder.isActive).thenReturn(true)
        `when`(recorder.stop()).thenAnswer { `when`(recorder.isActive).thenReturn(false); source }
        val credentials = mock(SecureCredentialStore::class.java)
        `when`(credentials.load()).thenReturn("test-key")
        val client = OpenRouterClient(OkHttpClient.Builder().addInterceptor { chain ->
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body("{\"text\":\"Test transcript\"}".toResponseBody()).build()
        }.build())
        var inserted: String? = null
        val current = WhisperManager(context, recorder, client, credentials)
        manager = current
        current.onEditorSessionChanged(1, false)
        current.onTranscriptionResult = { inserted = it.text }
        current.releaseRecord()
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (current.recordingState != WhisperManager.RecordingState.IDLE && System.nanoTime() < deadline) {
            shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(10)
        }
        assertEquals(WhisperManager.RecordingState.IDLE, current.recordingState)
        assertEquals("Test transcript", inserted)
        assertFalse(source.exists())
        return bytes
    }
    @Test fun preservesSentAudioAndRawTranscript() {
        val bytes = dictate(true)
        val store = RecordingLogStore.forContext(context)
        val record = store.list().single()
        assertArrayEquals(bytes, store.audioFile(record.getString("id")).readBytes())
        assertEquals("Test transcript", record.getString("rawTranscript"))
        assertEquals("Transcribed", record.getString("outcome"))
        assertFalse(record.toString().contains("test-key"))
    }
    @Test fun disabledLoggingDoesNotRetainAudio() {
        dictate(false)
        assertFalse(root.exists())
    }
    @Test fun failedLogWriteDoesNotBreakTranscription() {
        root.writeText("Block directory creation")
        dictate(true)
        assertTrue(root.isFile)
    }
}
