package helium314.keyboard.latin.whisper

import kotlinx.coroutines.runBlocking
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.ByteString
import org.json.JSONObject
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class GatewayStreamingTest {
    private val server = MockWebServer()
    private val texts = CopyOnWriteArrayList<JSONObject>()
    private val frames = CopyOnWriteArrayList<Int>()
    private var reply: (WebSocket, JSONObject) -> Unit = { socket, message ->
        if (message.getString("type") == "transcription-stream.audio-done") {
            socket.send(JSONObject().put("type", "transcript-delta").put("delta", "hello").toString())
            socket.send(JSONObject().put("type", "finish").put("text", " hello world ").toString())
        }
    }

    @Before fun setUp() {
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) { JSONObject(text).also { texts.add(it); reply(webSocket, it) } }
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) { frames.add(bytes.size) }
            override fun onOpen(webSocket: WebSocket, response: Response) {}
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null) }
        }))
        server.start()
    }
    @After fun tearDown() { server.shutdown() }

    private fun session(language: String = "auto") =
        GatewayStreamingSession("vck_secret", language, url = server.url("/v4/ai/transcription-model").toString().replace("http", "ws"))

    @Test fun streamsFramedPcmAndReturnsTheFinishedTranscript() = runBlocking {
        val live = session("en")
        live.send(ByteArray(3000), 3000)
        live.send(ByteArray(500), 500)
        assertEquals("hello world", live.finish())
        val request = server.takeRequest()
        assertEquals("ai-gateway-transcription.v1, ai-gateway-auth.vck_secret", request.getHeader("Sec-WebSocket-Protocol"))
        assertEquals("transcription-stream.start", texts.first().getString("type"))
        assertEquals(16000, texts.first().getJSONObject("inputAudioFormat").getInt("rate"))
        assertEquals("en", texts.first().getJSONObject("providerOptions").getJSONObject("azure").getString("language"))
        assertEquals(listOf(1280, 1280, 940), frames.toList(), "audio goes out in 40 ms frames, then the remainder")
        assertEquals("transcription-stream.audio-done", texts.last().getString("type"))
    }

    @Test fun replaysASavedRecordingWithoutItsHeader() = runBlocking {
        val wav = File.createTempFile("replay", ".wav").apply { writeBytes(AudioRecordingSpec.wavHeader(2560) + ByteArray(2560)); deleteOnExit() }
        val live = session()
        live.replay(wav)
        assertEquals("hello world", live.finish())
        assertFalse(texts.first().has("providerOptions"), "auto-detect sends no language hint")
        assertEquals(listOf(1280, 1280), frames.toList())
    }

    @Test fun providerErrorsFailWithTheKeyRedacted() = runBlocking {
        reply = { socket, message ->
            if (message.getString("type") == "transcription-stream.start")
                socket.send(JSONObject().put("type", "error").put("error", "bad credential vck_secret").toString())
        }
        val live = session()
        val error = assertFailsWith<IOException> { live.finish() }
        assertTrue(error.message!!.contains("bad credential [redacted]"), error.message)
        assertFalse(error.message!!.contains("vck_secret"))
    }

    @Test fun aCloseWithoutTheTranscriptIsAFailure() = runBlocking {
        reply = { socket, message -> if (message.getString("type") == "transcription-stream.audio-done") socket.close(1011, "upstream") }
        val error = assertFailsWith<IOException> { session().finish() }
        assertTrue(error.message!!.contains("closed before the completed transcript"), error.message)
    }

    @Test fun aSilentProviderTimesOut() = runBlocking {
        reply = { _, _ -> }
        val error = assertFailsWith<IOException> { session().finish(timeoutMs = 300) }
        assertTrue(error.message!!.contains("in time"))
    }
}
