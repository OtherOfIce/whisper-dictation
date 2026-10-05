package helium314.keyboard.latin.whisper

import android.app.Application
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Before
import org.junit.runner.RunWith
import org.mockito.Mockito.*
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.*

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class)
class WhisperManagerTest {
    private val context = ApplicationProvider.getApplicationContext<Application>()
    private val recorder = mock(AudioRecorder::class.java)
    private val credentials = mock(SecureCredentialStore::class.java)
    private val unblock = CountDownLatch(1)
    private lateinit var manager: WhisperManager

    @Before fun setUp() {
        WhisperManager.failedRecording(context).delete()
        `when`(credentials.load()).thenReturn("test-key")
        `when`(credentials.hasKey()).thenReturn(true)
        `when`(credentials.isAvailable()).thenReturn(true)
        `when`(recorder.start()).thenReturn(true)
        shadowOf(context).grantPermissions(android.Manifest.permission.RECORD_AUDIO)
    }

    @After fun tearDown() {
        unblock.countDown()
        if (::manager.isInitialized) manager.release()
        WhisperManager.failedRecording(context).delete()
    }

    private fun createManager(blockRequest: Boolean = false, savedRecording: Boolean = true) {
        val client = OpenRouterClient(OkHttpClient.Builder().addInterceptor { chain ->
            if (blockRequest) check(unblock.await(10, TimeUnit.SECONDS))
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                .code(200).message("OK").body("{\"text\":\"\"}".toResponseBody()).build()
        }.build())
        manager = WhisperManager(context, recorder, client, credentials)
        manager.onEditorSessionChanged(1, false)
        if (savedRecording) {
            WhisperManager.failedRecording(context).writeBytes(AudioRecordingSpec.wavHeader(0))
            assertEquals(WhisperManager.RecordingState.RETRY_READY, manager.recordingState)
        }
    }

    @Test fun cancellingRetryAllowsNextTapToRecord() {
        createManager(blockRequest = true)
        manager.toggleRecording()
        assertEquals(WhisperManager.RecordingState.TRANSCRIBING, manager.recordingState)
        manager.toggleRecording()
        assertEquals(WhisperManager.RecordingState.IDLE, manager.recordingState)
        assertFalse(WhisperManager.failedRecording(context).exists())
        manager.toggleRecording()
        verify(recorder).start()
    }

    @Test fun failedRetryAllowsNextTapToRecord() {
        createManager()
        manager.toggleRecording()
        awaitRequestFinished()
        assertEquals(WhisperManager.RecordingState.IDLE, manager.recordingState)
        assertFalse(WhisperManager.failedRecording(context).exists())
        manager.toggleRecording()
        verify(recorder).start()
    }

    private fun awaitRequestFinished() {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (manager.recordingState == WhisperManager.RecordingState.TRANSCRIBING && System.nanoTime() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(10)
        }
    }

    @Test fun initialFailureStillOffersOneRetry() {
        createManager(savedRecording = false)
        val audio = File(context.cacheDir, "test-recording.wav").apply {
            writeBytes(AudioRecordingSpec.wavHeader(2) + byteArrayOf(1, 2))
        }
        `when`(recorder.isActive).thenReturn(true)
        `when`(recorder.stop()).thenAnswer {
            `when`(recorder.isActive).thenReturn(false)
            audio
        }
        manager.toggleRecording()
        awaitRequestFinished()
        assertEquals(WhisperManager.RecordingState.RETRY_READY, manager.recordingState)
        assertEquals(46L, WhisperManager.failedRecording(context).length())
        assertFalse(audio.exists())
    }

    @Test fun retryWithoutCredentialsReturnsToIdle() {
        createManager()
        `when`(credentials.load()).thenReturn(null)
        manager.toggleRecording()
        assertEquals(WhisperManager.RecordingState.IDLE, manager.recordingState)
        assertFalse(WhisperManager.failedRecording(context).exists())
    }

    @Test fun hidingKeyboardPreservesUnretriedRecording() {
        createManager()
        manager.onEditorSessionChanged(2, false)
        assertEquals(WhisperManager.RecordingState.RETRY_READY, manager.recordingState)
        assertTrue(WhisperManager.failedRecording(context).exists())
    }
}
