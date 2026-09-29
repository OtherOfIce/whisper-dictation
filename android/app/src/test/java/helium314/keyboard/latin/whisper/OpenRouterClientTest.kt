package helium314.keyboard.latin.whisper

import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
class OpenRouterClientTest {
    @Test fun racesTwoMaiCallsAndUsesFirstSuccessfulResponse() = runBlocking {
        val count = AtomicInteger()
        val bothStarted = CountDownLatch(2)
        val client = testClient { chain ->
            val number = count.incrementAndGet()
            bothStarted.countDown()
            check(bothStarted.await(5, TimeUnit.SECONDS))
            if (number == 1) Thread.sleep(150)
            response(chain, 200, "{\"text\":\"${if (number == 1) "slow" else "fast"}\"}")
        }
        val audio = audioFile()
        try {
            assertEquals("fast", client.transcribe(audio, "test-key", "auto", emptyList(), "mai-transcribe-2-clean", true))
            assertEquals(2, count.get())
        } finally { audio.delete() }
    }

    @Test fun fallsBackToGptWhenBothMaiCallsFail() = runBlocking {
        val maiCalls = AtomicInteger()
        val gptCalls = AtomicInteger()
        val client = testClient { chain ->
            val body = chain.request().body!!.let { requestBody ->
                val buffer = okio.Buffer()
                requestBody.writeTo(buffer)
                buffer.readUtf8()
            }
            if (org.json.JSONObject(body).getString("model") == "microsoft/mai-transcribe-2") {
                maiCalls.incrementAndGet()
                response(chain, 503, "{}")
            } else {
                gptCalls.incrementAndGet()
                response(chain, 200, "{\"text\":\"recovered\"}")
            }
        }
        val audio = audioFile()
        try {
            assertEquals("recovered", client.transcribeWithFallback(audio, "test-key", "auto", emptyList(), "mai-transcribe-2-clean", true))
            assertTrue(maiCalls.get() >= 2)
            assertEquals(1, gptCalls.get())
        } finally { audio.delete() }
    }

    @Test fun rejectsTruncatedLunaOutput() = runBlocking {
        val client = testClient { chain -> response(chain, 200,
            "{\"choices\":[{\"finish_reason\":\"length\",\"message\":{\"content\":\"partial\"}}]}") }
        val error = runCatching { client.clean("Some text", "test-key") }.exceptionOrNull()
        assertTrue(error is java.io.IOException)
    }

    private fun testClient(interceptor: Interceptor) = OpenRouterClient(OkHttpClient.Builder().addInterceptor(interceptor).build())

    private fun audioFile(): File = File.createTempFile("dictation-test", ".wav").apply {
        writeBytes(AudioRecordingSpec.wavHeader(0))
    }

    private fun response(chain: Interceptor.Chain, code: Int, body: String) = Response.Builder()
        .request(chain.request()).protocol(Protocol.HTTP_1_1).code(code)
        .message(if (code == 200) "OK" else "Error")
        .body(body.toResponseBody("application/json".toMediaType())).build()
}
