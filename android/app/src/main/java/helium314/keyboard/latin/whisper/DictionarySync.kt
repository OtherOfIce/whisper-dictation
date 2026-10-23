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

/**
 * Syncs the dictionary. Paired with an account, it syncs the one list the desktop gave this phone; otherwise it can
 * still use the older shared key. The account itself lives in [Account].
 */
object DictionarySync {
    private val mutex = Mutex()
    private val client = OkHttpClient.Builder().callTimeout(15, TimeUnit.SECONDS).followRedirects(false).build()
    private fun store(context: Context) = SecureCredentialStore.open(context, "dictionary-sync")
    fun connection(context: Context): JSONObject = store(context).load()?.let(::JSONObject) ?: JSONObject()
    fun url(context: Context) = Account.url(context).ifBlank { connection(context).optString("url") }
    fun usesSharedKey(context: Context) = !Account.isSignedIn(context) && connection(context).optString("key").isNotBlank()

    fun origin(url: String): String {
        val uri = URI(url.trim())
        require(uri.scheme == "https" && uri.host?.matches(Regex("[a-z0-9-]+\\.convex\\.site")) == true && uri.port == -1 && uri.userInfo == null && uri.query == null && uri.fragment == null && uri.path.orEmpty() in listOf("", "/")) { "Enter your https://deployment.convex.site URL" }
        return "https://${uri.host}"
    }

    suspend fun configure(context: Context, url: String, key: String) = mutex.withLock {
        require(!Account.isSignedIn(context)) { "Sign out before using a shared sync key" }
        if (url.isBlank()) { store(context).clear(); return@withLock }
        val old = connection(context)
        val secret = key.ifBlank { old.optString("key") }
        val origin = origin(url)
        require(secret.matches(Regex("[A-Za-z0-9_-]{32,256}"))) { "Use a sync key of 32–256 letters, numbers, underscores or hyphens" }
        val base = if (old.optString("url") == origin && old.optString("key") == secret) old.optJSONArray("base") ?: JSONArray() else JSONArray()
        check(store(context).save(JSONObject().put("url", origin).put("key", secret).put("base", base).toString())) { "Could not save encrypted sync settings" }
    }

    /** Joining or leaving an account: the next sync merges local terms into the account's list instead of deleting them. */
    suspend fun resetAccount(context: Context) = mutex.withLock {
        val state = connection(context)
        state.put("base", JSONArray()); state.remove("list")
        store(context).save(state.toString())
    }

    suspend fun sync(context: Context): String = mutex.withLock {
        try {
            val state = connection(context)
            val signedIn = Account.isSignedIn(context)
            val list = if (signedIn) Account.grants(context)?.dictionary else null
            if (signedIn && list == null) return@withLock "Dictionary sync is off for this device"
            if (!signedIn && state.optString("key").isBlank()) return@withLock if (state.optString("url").isBlank()) "Sync is off" else "Pair this device to sync"
            val prefs = context.prefs()
            fun local() = DictionaryChanges.normalize(prefs.getString(Settings.PREF_WHISPER_DICTIONARY, "").orEmpty().split('\n'))
            val snapshot = local()
            // Moving to a different list replaces the local terms with that list; the old list stays on the server.
            if (signedIn && state.has("list") && state.optString("list") != list) state.put("base", JSONArray(snapshot))
            val delta = DictionaryChanges.changes(strings(state.optJSONArray("base") ?: JSONArray()), snapshot)
            val body = JSONObject().put("add", JSONArray(delta.first)).put("remove", JSONArray(delta.second))
            val reply = if (signedIn) Account.request(context, "/dictionary/sync", body) else withContext(Dispatchers.IO) {
                val request = Request.Builder().url(state.getString("url") + "/dictionary/sync").header("Authorization", "Bearer ${state.getString("key")}")
                    .post(body.toString().toRequestBody("application/json".toMediaType())).build()
                client.newCall(request).execute().use { response ->
                    check(response.isSuccessful) { if (response.code == 401) "Sync key was rejected" else "Dictionary sync failed" }
                    JSONObject(response.body!!.string())
                }
            }
            if (reply.optBoolean("off")) return@withLock "Dictionary sync is off for this device"
            val remote = DictionaryChanges.normalize(strings(reply.getJSONArray("terms")))
            val pending = DictionaryChanges.changes(snapshot, local())
            val merged = DictionaryChanges.apply(remote, pending.first, pending.second)
            check(prefs.edit().putString(Settings.PREF_WHISPER_DICTIONARY, merged.joinToString("\n")).commit()) { "Could not save dictionary" }
            state.put("base", JSONArray(remote))
            if (signedIn) state.put("list", reply.optString("list", list)) else state.remove("list")
            check(store(context).save(state.toString())) { "Could not save sync progress" }
            "Synced"
        } catch (error: kotlinx.coroutines.CancellationException) { throw error }
        catch (_: Account.SignedOut) { "" }
        catch (_: Exception) { "Sync failed. Local terms are saved; sync will retry." }
    }
    private fun strings(array: JSONArray) = (0 until array.length()).map { array.getString(it) }
}
