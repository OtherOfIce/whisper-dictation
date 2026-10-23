package helium314.keyboard.latin.whisper

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.Base64
import java.util.concurrent.TimeUnit

/**
 * The account this phone belongs to. Accounts are created on a Windows desktop; this phone joins by typing a one-time
 * pairing code made there. The token, what the desktop granted, and the keys it was given (only for granted groups) are
 * kept in the Keystore-backed store. Mirrors desktop/account.cjs.
 */
object Account {
    data class Grants(val secrets: Boolean, val settings: Boolean, val dictionary: String?)

    private const val STORE = "account"
    internal var client = OkHttpClient.Builder().callTimeout(20, TimeUnit.SECONDS).followRedirects(false).build()
    private val json = "application/json".toMediaType()
    class SignedOut : IOException("This device was signed out. Pair it again from your desktop.")
    @Volatile var message = ""
        private set

    private fun state(context: Context): JSONObject = SecureCredentialStore.open(context, STORE).load()?.let { runCatching { JSONObject(it) }.getOrNull() } ?: JSONObject()
    private fun save(context: Context, state: JSONObject) = check(SecureCredentialStore.open(context, STORE).save(state.toString())) { "Could not save the account" }

    fun isSignedIn(context: Context) = state(context).optString("token").isNotBlank()
    fun username(context: Context): String = state(context).optString("username")
    fun deviceName(context: Context): String = state(context).optString("name")
    fun url(context: Context): String = state(context).optString("url")
    fun grants(context: Context): Grants? = state(context).optJSONObject("grants")?.let(::grantsOf)
    private fun grantsOf(value: JSONObject) = Grants(value.optBoolean("secrets"), value.optBoolean("settings"), if (value.isNull("dictionary")) null else value.optString("dictionary").ifBlank { null })
    fun keyFor(context: Context, group: String): ByteArray? =
        state(context).optJSONObject("keyring")?.optString(group)?.takeIf { it.isNotBlank() }?.let { Base64.getDecoder().decode(it) }

    suspend fun pair(context: Context, url: String, code: String) {
        val origin = DictionarySync.origin(url)
        val pairing = withContext(Dispatchers.Default) { VaultCrypto.derivePairing(code) }
        val reply = post(origin, "/pair/claim", JSONObject().put("pairId", pairing.pairId))
        val token = reply.getString("token")
        val payload = try { JSONObject(VaultCrypto.open(pairing.key, "pairing", reply.getString("payload"))) }
        catch (_: Exception) {
            runCatching { post(origin, "/account/sign-out", JSONObject(), token) }
            throw IOException("That pairing code did not match. Make a new one on your desktop.")
        }
        // Nothing from a previous account carries over.
        AccountItems.forget(context); DictionarySync.resetAccount(context)
        save(context, JSONObject().put("url", origin).put("username", reply.getString("username")).put("token", token).put("name", reply.getString("name"))
            .put("grants", reply.getJSONObject("grants")).put("keyring", payload.optJSONObject("keyring") ?: JSONObject.NULL))
        message = ""
    }

    suspend fun signOut(context: Context): String {
        val state = state(context)
        val token = state.optString("token")
        val revoked = token.isBlank() || runCatching { post(state.getString("url"), "/account/sign-out", JSONObject(), token) }.isSuccess
        save(context, JSONObject().put("url", state.optString("url")))
        AccountItems.forget(context); DictionarySync.resetAccount(context)
        message = if (revoked) "Signed out" else "Signed out on this device. The server could not be reached to remove it."
        return message
    }

    /** The server no longer knows this device: it was removed on the desktop. Local keys and settings stay. */
    fun dropped(context: Context) {
        save(context, JSONObject().put("url", state(context).optString("url")))
        message = "This device was signed out. Pair it again from your desktop."
    }

    /** Picks up grant changes made on the desktop, which arrive with every item sync. */
    fun noteGrants(context: Context, grants: JSONObject?) {
        if (grants == null) return
        val state = state(context)
        if (state.optString("token").isBlank() || state.optJSONObject("grants")?.toString() == grants.toString()) return
        save(context, state.put("grants", grants))
    }

    /** Dictionary, settings and API keys. Each part reports its own problems and never blocks the others. */
    suspend fun syncAll(context: Context): String {
        val items = AccountItems.sync(context)
        val dictionary = DictionarySync.sync(context)
        return message.ifBlank { if (items.isNotBlank() && items != "Synced") items else dictionary }
    }

    /** A request with this device's token. A 401 means the device was removed, so the account is dropped. */
    suspend fun request(context: Context, path: String, body: JSONObject): JSONObject {
        val state = state(context)
        val token = state.optString("token")
        if (token.isBlank()) throw IOException("Pair this device to sync")
        return try { post(state.getString("url"), path, body, token) } catch (error: SignedOut) { dropped(context); throw error }
    }

    private suspend fun post(origin: String, path: String, body: JSONObject, token: String? = null): JSONObject = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(origin + path)
            .apply { if (token != null) header("Authorization", "Bearer $token") }
            .post(body.toString().toRequestBody(json)).build()
        client.newCall(request).execute().use { response ->
            val parsed = runCatching { JSONObject(response.body?.string().orEmpty()) }.getOrNull()
            if (response.code == 401 && token != null) throw SignedOut()
            if (!response.isSuccessful) throw IOException(parsed?.optString("error")?.takeIf { it.isNotBlank() } ?: "Request failed (${response.code})")
            parsed ?: JSONObject()
        }
    }

    internal fun resetForTests() { message = "" }
}
