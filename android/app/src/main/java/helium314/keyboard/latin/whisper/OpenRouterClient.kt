package helium314.keyboard.latin.whisper

import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.coroutineContext
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class OpenRouterClient {
    private val client = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS).writeTimeout(120, TimeUnit.SECONDS).callTimeout(120, TimeUnit.SECONDS).build()
    private val callLock = Any()
    private var activeCall: Call? = null

    suspend fun transcribe(file: File, apiKey: String, language: String, keywords: List<String>): String = withContext(Dispatchers.IO) {
        val body = JSONObject().put("model", "openai/gpt-transcribe")
            .put("input_audio", JSONObject().put("data", Base64.encodeToString(file.readBytes(), Base64.NO_WRAP)).put("format", "m4a"))
        if (language != "auto") body.put("language", language)
        if (keywords.isNotEmpty()) body.put("provider", JSONObject().put("options",
            JSONObject().put("openai", JSONObject().put("keywords", JSONArray(keywords)))))
        coroutineContext.ensureActive()
        val request = Request.Builder().url("https://openrouter.ai/api/v1/audio/transcriptions")
            .header("Authorization", "Bearer $apiKey").post(body.toString().toRequestBody("application/json".toMediaType())).build()
        val call = client.newCall(request)
        synchronized(callLock) { activeCall = call }
        suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, error: IOException) {
                    clear(call)
                    if (continuation.isActive) continuation.resumeWithException(error)
                }

                override fun onResponse(call: Call, response: okhttp3.Response) {
                    clear(call)
                    try {
                        response.use {
                            val responseBody = response.body?.string().orEmpty()
                            if (!response.isSuccessful) throw OpenRouterException(response.code)
                            val value = JSONObject(responseBody).opt("text")
                            if (value !is String) throw IllegalStateException("OpenRouter response has no text field")
                            if (continuation.isActive) continuation.resume(value.trim())
                        }
                    } catch (error: Exception) {
                        if (continuation.isActive) continuation.resumeWithException(error)
                    }
                }
            })
            if (!continuation.isActive) call.cancel()
        }
    }

    fun cancel() {
        val call = synchronized(callLock) { activeCall.also { activeCall = null } }
        call?.cancel()
    }

    private fun clear(call: Call) = synchronized(callLock) {
        if (activeCall === call) activeCall = null
    }
}

class OpenRouterException(statusCode: Int) : Exception("OpenRouter returned HTTP $statusCode")
