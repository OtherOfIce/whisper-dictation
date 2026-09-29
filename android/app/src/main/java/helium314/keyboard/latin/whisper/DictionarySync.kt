package helium314.keyboard.latin.whisper

import android.content.Context
import helium314.keyboard.latin.settings.Settings
import helium314.keyboard.latin.utils.prefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.util.concurrent.TimeUnit

object DictionarySync {
    private const val CONNECTION = "whisper_dictionary_sync"
    private val mutex = Mutex()
    private val client = OkHttpClient.Builder().callTimeout(15, TimeUnit.SECONDS).followRedirects(false).build()
    fun connection(context: Context): JSONObject = SecureCredentialStore(context, "dictionary-sync").load()?.let(::JSONObject) ?: JSONObject()
    fun url(context: Context) = connection(context).optString("url")

    suspend fun configure(context: Context, url: String, key: String) = mutex.withLock {
        val store = SecureCredentialStore(context, "dictionary-sync")
        if (url.isBlank()) { store.clear(); return@withLock }
        val old = connection(context)
        val secret = key.ifBlank { old.optString("key") }
        val uri = URI(url.trim())
        require(uri.scheme == "https" && uri.host?.matches(Regex("[a-z0-9-]+\\.convex\\.site")) == true && uri.port == -1 && uri.userInfo == null && uri.query == null && uri.fragment == null && uri.path.orEmpty() in listOf("", "/")) { "Enter your https://deployment.convex.site URL" }
        require(secret.matches(Regex("[A-Za-z0-9_-]{32,256}"))) { "Use a sync key of 32–256 letters, numbers, underscores or hyphens" }
        val origin = "https://${uri.host}"
        val base = if (old.optString("url") == origin && old.optString("key") == secret) old.optJSONArray("base") ?: JSONArray() else JSONArray()
        check(store.save(JSONObject().put("url", origin).put("key", secret).put("base", base).toString())) { "Could not save encrypted sync settings" }
    }

    suspend fun sync(context: Context): String = mutex.withLock {
        try {
            val state = connection(context)
            if (state.optString("url").isBlank()) return@withLock "Sync is off"
            val prefs = context.prefs()
            fun local() = DictionaryChanges.normalize(prefs.getString(Settings.PREF_WHISPER_DICTIONARY, "").orEmpty().split('\n'))
            val snapshot = local()
            val delta = DictionaryChanges.changes(strings(state.optJSONArray("base") ?: JSONArray()), snapshot)
            val body = JSONObject().put("add", JSONArray(delta.first)).put("remove", JSONArray(delta.second)).toString()
            val remote = withContext(Dispatchers.IO) {
                val request = Request.Builder().url(state.getString("url") + "/dictionary/sync")
                    .header("Authorization", "Bearer ${state.getString("key")}")
                    .post(body.toRequestBody("application/json".toMediaType())).build()
                client.newCall(request).execute().use { response ->
                    check(response.isSuccessful) { if (response.code == 401) "Sync key was rejected" else "Dictionary sync failed" }
                    DictionaryChanges.normalize(strings(JSONObject(response.body!!.string()).getJSONArray("terms")))
                }
            }
            val pending = DictionaryChanges.changes(snapshot, local())
            val merged = DictionaryChanges.apply(remote, pending.first, pending.second)
            check(prefs.edit().putString(Settings.PREF_WHISPER_DICTIONARY, merged.joinToString("\n")).commit()) { "Could not save dictionary" }
            state.put("base", JSONArray(remote))
            check(SecureCredentialStore(context, "dictionary-sync").save(state.toString())) { "Could not save sync progress" }
            "Synced"
        } catch (error: kotlinx.coroutines.CancellationException) { throw error }
        catch (_: Exception) { "Sync failed. Local terms are saved; sync will retry." }
    }
    private fun strings(array: JSONArray) = (0 until array.length()).map { array.getString(it) }
}
