package helium314.keyboard.latin.whisper

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.util.concurrent.TimeUnit

/**
 * One live MAI-Transcribe-2 session through the Vercel AI Gateway, fed with 16 kHz mono PCM while recording.
 * Mirrors GatewayStreamingProtocol and StreamingSession in the desktop engine. The socket opens as soon as the session
 * is created; audio sent before it is open is queued by OkHttp. The key travels only in the WebSocket subprotocol and
 * is redacted from every error message.
 */
class GatewayStreamingSession(
    private val apiKey: String,
    language: String,
    client: OkHttpClient = sharedClient,
    url: String = URL,
) {
    private val result = CompletableDeferred<String>()
    private val lock = Any()
    private val frame = ByteArray(FRAME_BYTES)
    private var filled = 0
    private var inputDone = false
    private val socket: WebSocket

    init {
        val request = Request.Builder().url(url)
            .header("Sec-WebSocket-Protocol", "ai-gateway-transcription.v1, ai-gateway-auth.$apiKey").build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) = read(text)
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) = fail(IOException("Invalid streaming transcription event."))
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                fail(IOException("Streaming connection closed before the completed transcript (code $code${reason.takeIf { it.isNotBlank() }?.let { ": ${redact(it)}" } ?: ""})."))
                webSocket.close(1000, null)
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
                fail(IOException(response?.let { "Vercel AI Gateway refused the streaming connection (HTTP ${it.code})." }
                    ?: "Streaming connection failed (${t.javaClass.simpleName})."))
        })
        val start = JSONObject().put("type", "transcription-stream.start")
            .put("inputAudioFormat", JSONObject().put("type", "audio/pcm").put("rate", AudioRecordingSpec.SAMPLE_RATE))
        if (language != "auto") start.put("providerOptions", JSONObject().put("azure", JSONObject().put("language", language)))
        socket.send(start.toString())
    }

    /** True once the provider has failed; the recording carries on and is transcribed another way. */
    val failed get() = result.isCompleted && result.getCompletionExceptionOrNull() != null

    /** Called from the recording thread with each block of PCM, which may be reused afterwards. */
    fun send(pcm: ByteArray, length: Int) = synchronized(lock) {
        if (inputDone || result.isCompleted) return
        var offset = 0
        while (offset < length) {
            val bytes = minOf(FRAME_BYTES - filled, length - offset)
            System.arraycopy(pcm, offset, frame, filled, bytes)
            offset += bytes; filled += bytes
            if (filled == FRAME_BYTES) { socket.send(frame.toByteString()); filled = 0 }
        }
    }

    /** Streams a saved recording, for a retry. */
    fun replay(wav: File) {
        RandomAccessFile(wav, "r").use { input ->
            input.seek(44)
            val buffer = ByteArray(32_000)
            while (true) { val read = input.read(buffer); if (read <= 0) break; send(buffer, read) }
        }
    }

    /** Ends the audio and waits for the completed transcript. */
    suspend fun finish(timeoutMs: Long = 30_000): String {
        synchronized(lock) {
            if (!inputDone && !result.isCompleted) {
                if (filled > 0) socket.send(frame.toByteString(0, filled))
                filled = 0
                socket.send(JSONObject().put("type", "transcription-stream.audio-done").toString())
            }
            inputDone = true
        }
        try { return withTimeout(timeoutMs) { result.await() } }
        catch (_: TimeoutCancellationException) { throw IOException("Streaming provider did not return the completed transcript in time.") }
        finally { socket.close(1000, null) }
    }

    fun cancel() { result.cancel(); socket.cancel() }

    private fun read(text: String) {
        val message = runCatching { JSONObject(text) }.getOrElse { fail(IOException("Invalid streaming transcription event.")); return }
        when (message.optString("type")) {
            "error" -> fail(IOException("Vercel AI Gateway streaming failed: " + detail(message)))
            "finish" -> {
                val transcript = message.opt("text") as? String
                when {
                    !synchronized(lock) { inputDone } -> fail(IOException("Streaming provider completed before all audio was sent."))
                    transcript.isNullOrBlank() -> fail(IOException("Streaming provider returned no transcript."))
                    else -> result.complete(transcript.trim())
                }
            }
        }
    }

    private fun fail(error: Exception) { if (result.completeExceptionally(error)) socket.cancel() }

    private fun detail(message: JSONObject): String {
        val raw = message.opt("error") ?: message
        val text = (if (raw is String) raw else raw.toString()).split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
        val safe = redact(text)
        return when { safe.isEmpty() -> "no error detail"; safe.length > 300 -> safe.take(300) + "…"; else -> safe }
    }

    private fun redact(text: String) = if (apiKey.isEmpty()) text else text.replace(apiKey, "[redacted]")

    companion object {
        const val MODEL = "mai-transcribe-2-streaming"
        const val URL = "wss://ai-gateway.vercel.sh/v4/ai/transcription-model?ai-model-id=microsoft%2Fmai-transcribe-2-streaming"
        const val FRAME_BYTES = 1280
        private val sharedClient by lazy { OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS).build() }
    }
}
