package helium314.keyboard.latin.whisper

import android.app.Application
import androidx.core.content.edit
import androidx.test.core.app.ApplicationProvider
import helium314.keyboard.latin.settings.Settings
import helium314.keyboard.latin.utils.prefs
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Before
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Pairs a phone with an account made on the desktop and syncs it against a fake of sync/convex, which enforces grants the same way. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class)
class AccountItemsTest {
    private val context = ApplicationProvider.getApplicationContext<Application>()
    private val secretsKey = ByteArray(32) { it.toByte() }
    private val origin = "https://test.convex.site"

    private class Memory : CredentialStorage {
        var value: String? = null
        override fun load() = value
        override fun save(value: String): Boolean { this.value = value; return true }
        override fun clear() { value = null }
        override fun peek(): SecureCredentialStore.Peek = value?.let { SecureCredentialStore.Peek.Value(it) } ?: SecureCredentialStore.Peek.Empty
    }
    private val stores = HashMap<String, Memory>()

    /** What the desktop set up: items, dictionary lists, and the pairing code waiting to be typed on the phone. */
    private inner class Server {
        val items = LinkedHashMap<String, JSONObject>()
        val lists = HashMap<String, MutableList<String>>()
        var grants = JSONObject().put("secrets", true).put("settings", true).put("history", false).put("dictionary", "Personal")
        var pairings = HashMap<String, JSONObject>()
        var removed = false
        fun put(name: String, value: String, at: Long = System.currentTimeMillis() - 1000) { items[name] = JSONObject().put("name", name).put("value", value).put("deleted", false).put("updatedAt", at) }
        fun putSecret(name: String, key: String) = put(name, VaultCrypto.seal(secretsKey, name, key))
        fun secret(name: String) = items[name]?.let { if (it.getBoolean("deleted")) null else VaultCrypto.open(secretsKey, name, it.getString("value")) }
        fun addPairing(code: String, withKeys: Boolean) {
            val pairing = VaultCrypto.derivePairing(code)
            val keyring = if (withKeys) JSONObject().put("v", 1).put("secrets", java.util.Base64.getEncoder().encodeToString(secretsKey)) else JSONObject.NULL
            pairings[pairing.pairId] = JSONObject().put("payload", VaultCrypto.seal(pairing.key, "pairing", JSONObject().put("v", 1).put("keyring", keyring).toString()))
            grants.put("secrets", withKeys)
        }
        private fun allows(name: String) = grants.optBoolean(name.substringBefore('.'))
        fun handle(path: String, token: String?, body: JSONObject): Pair<Int, JSONObject> {
            if (path == "/pair/claim") {
                val pairing = pairings.remove(body.getString("pairId")) ?: return 404 to JSONObject().put("error", "That pairing code did not work.")
                return 200 to JSONObject().put("token", "lwd_phone").put("username", "me@x.co").put("name", "Phone").put("admin", false).put("grants", JSONObject(grants.toString())).put("payload", pairing.getString("payload"))
            }
            if (token != "lwd_phone" || removed) return 401 to JSONObject()
            return when (path) {
                "/account/sign-out" -> { removed = true; 200 to JSONObject().put("ok", true) }
                "/dictionary/sync" -> {
                    val list = if (grants.isNull("dictionary")) null else grants.getString("dictionary")
                    if (list == null) return 200 to JSONObject().put("off", true)
                    val terms = lists.getOrPut(list) { mutableListOf() }
                    body.getJSONArray("remove").let { remove -> for (i in 0 until remove.length()) terms.removeAll { it.equals(remove.getString(i), true) } }
                    body.getJSONArray("add").let { add -> for (i in 0 until add.length()) if (terms.none { it.equals(add.getString(i), true) }) terms.add(add.getString(i)) }
                    200 to JSONObject().put("terms", JSONArray(terms)).put("list", list)
                }
                else -> {
                    val rejected = JSONArray()
                    val incoming = body.getJSONArray("items")
                    for (index in 0 until incoming.length()) {
                        val item = incoming.getJSONObject(index)
                        val name = item.getString("name")
                        if (!allows(name)) { rejected.put(name); continue }
                        if ((items[name]?.getLong("updatedAt") ?: -1L) < item.getLong("updatedAt")) items[name] = JSONObject(item.toString())
                    }
                    val visible = JSONArray(items.values.filter { allows(it.getString("name")) })
                    200 to JSONObject().put("items", visible).put("rejected", rejected).put("serverTime", 0).put("grants", JSONObject(grants.toString())).put("admin", false)
                }
            }
        }
    }
    private val server = Server()

    @Before fun setUp() {
        SecureCredentialStore.factory = { _, name -> stores.getOrPut(name) { Memory() } }
        Account.client = OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            val buffer = Buffer(); chain.request().body!!.writeTo(buffer)
            val token = chain.request().header("Authorization")?.removePrefix("Bearer ")
            val (code, reply) = server.handle(chain.request().url.encodedPath, token, JSONObject(buffer.readUtf8()))
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(code).message("x")
                .body(reply.toString().toResponseBody("application/json".toMediaType())).build()
        }).build()
        AccountItems.resetForTests(); Account.resetForTests()
        context.prefs().edit { clear() }
    }
    @After fun tearDown() { SecureCredentialStore.factory = { context, name -> SecureCredentialStore(context, name) }; context.prefs().edit { clear() } }

    private fun pref(name: String) = context.prefs().all[name]
    private fun openRouterKey() = (SecureCredentialStore.open(context).peek() as? SecureCredentialStore.Peek.Value)?.key
    private fun terms() = context.prefs().getString(Settings.PREF_WHISPER_DICTIONARY, "").orEmpty().split('\n').filter { it.isNotBlank() }
    private suspend fun pair(withKeys: Boolean = true) {
        server.addPairing("7K3M-Q9XZ-04AB", withKeys)
        Account.pair(context, origin, "7k3m q9xz 04ab")
        Account.syncAll(context)
    }

    @Test fun pairingBringsTheDesktopKeysAndSettings() = runBlocking {
        server.putSecret("secrets.openrouter", "sk-or-desk")
        server.putSecret("secrets.xai", "xai-desk")
        server.put("settings.transcriptionModel", "\"gpt-transcribe\"")
        server.put("settings.cleanupMode", "\"luna\"")
        server.put("settings.raceMai", "false")
        server.lists["Personal"] = mutableListOf("Astra")
        context.prefs().edit { putString(Settings.PREF_WHISPER_DICTIONARY, "Borealis") }

        assertFailsWith<Exception> { Account.pair(context, origin, "0000-0000-0000") }
        pair()
        assertTrue(Account.isSignedIn(context))
        assertEquals("Phone", Account.deviceName(context))
        assertEquals("sk-or-desk", openRouterKey())
        assertEquals("gpt-transcribe", pref(Settings.PREF_WHISPER_TRANSCRIPTION_MODEL))
        assertEquals(true, pref(WhisperManager.PREF_LUNA_CLEANUP))
        assertEquals(false, pref(WhisperManager.PREF_RACE_MAI))
        assertEquals(listOf("Astra", "Borealis"), terms().sorted(), "local terms merge into the list on first sync")
        assertEquals("xai-desk", server.secret("secrets.xai"), "keys this phone does not use are left alone")

        // An edit here reaches the account sealed; a key cleared on the desktop is cleared here.
        SecureCredentialStore.open(context).save("sk-or-phone")
        Account.syncAll(context)
        assertEquals("sk-or-phone", server.secret("secrets.openrouter"))
        assertFalse(server.items.values.joinToString().contains("sk-or-phone"))
        server.items["secrets.openrouter"] = JSONObject().put("name", "secrets.openrouter").put("value", "").put("deleted", true).put("updatedAt", System.currentTimeMillis() + 60_000)
        Account.syncAll(context)
        assertNull(openRouterKey())
    }

    @Test fun aPhonePairedWithoutKeysNeverGetsOrSendsThem() = runBlocking {
        server.putSecret("secrets.openrouter", "sk-or-desk")
        SecureCredentialStore.open(context).save("sk-phone-own")
        pair(withKeys = false)
        assertNull(Account.keyFor(context, "secrets"))
        assertEquals("sk-phone-own", openRouterKey())
        assertEquals("sk-or-desk", server.secret("secrets.openrouter"))
    }

    @Test fun grantChangesFromTheDesktopArriveWithTheNextSync() = runBlocking {
        server.lists["Personal"] = mutableListOf("Astra")
        server.lists["Work"] = mutableListOf("Kubernetes")
        pair()
        assertEquals(listOf("Astra"), terms())
        server.grants.put("dictionary", "Work").put("settings", false)
        Account.syncAll(context)
        assertEquals(false, Account.grants(context)!!.settings)
        assertEquals(listOf("Kubernetes"), terms(), "moving to another list replaces the local terms")
        Account.syncAll(context)
        assertEquals<List<String>?>(listOf("Astra"), server.lists["Personal"], "and does not copy them into the new list")
        server.put("settings.raceMai", "false", System.currentTimeMillis() + 60_000)
        Account.syncAll(context)
        assertNull(pref(WhisperManager.PREF_RACE_MAI), "settings no longer granted are not applied")
        server.grants.put("dictionary", JSONObject.NULL)
        assertEquals("Dictionary sync is off for this device", DictionarySync.sync(context))
    }

    @Test fun removalOnTheDesktopSignsThePhoneOutAndKeepsItsKey() = runBlocking {
        SecureCredentialStore.open(context).save("sk-phone")
        pair()
        server.removed = true
        Account.syncAll(context)
        assertFalse(Account.isSignedIn(context))
        assertTrue(Account.message.contains("signed out"))
        assertEquals("sk-phone", openRouterKey())
    }

    @Test fun theFasterCleanupVariantAndUnsupportedModelsAreHandled() = runBlocking {
        context.prefs().edit { putString(Settings.PREF_WHISPER_TRANSCRIPTION_MODEL, "mai-transcribe-2-clean") }
        server.put("settings.cleanupMode", "\"luna-fast\"")
        server.put("settings.transcriptionModel", "\"grok-voice-transcribe-2\"")
        pair()
        assertEquals(true, pref(WhisperManager.PREF_LUNA_CLEANUP))
        assertEquals("luna-fast", pref(AccountItems.PREF_CLEANUP_VARIANT))
        assertEquals("mai-transcribe-2-clean", pref(Settings.PREF_WHISPER_TRANSCRIPTION_MODEL))
        Account.syncAll(context)
        assertEquals("\"luna-fast\"", server.items.getValue("settings.cleanupMode").getString("value"), "not flattened back to plain Luna")
        assertEquals("\"grok-voice-transcribe-2\"", server.items.getValue("settings.transcriptionModel").getString("value"))
    }

    @Test fun anUnreadableKeyIsNeverTreatedAsDeleted() = runBlocking {
        SecureCredentialStore.open(context).save("sk-phone")
        pair()
        assertNotNull(server.secret("secrets.openrouter"))
        val inner = stores.getValue("openrouter")
        SecureCredentialStore.factory = { _, name -> if (name == "openrouter") object : CredentialStorage by inner { override fun peek() = SecureCredentialStore.Peek.Unreadable } else stores.getOrPut(name) { Memory() } }
        assertTrue(AccountItems.sync(context).contains("Unlock the device"))
        assertEquals("sk-phone", server.secret("secrets.openrouter"))
    }

    @Test fun theGatewayKeyAndLiveMaiArriveFromTheDesktop() = runBlocking {
        server.putSecret("secrets.gateway", "vck-desk")
        server.put("settings.transcriptionModel", "\"mai-transcribe-2-streaming\"")
        pair()
        assertEquals("vck-desk", (SecureCredentialStore.open(context, "gateway").peek() as? SecureCredentialStore.Peek.Value)?.key)
        assertEquals("mai-transcribe-2-streaming", pref(Settings.PREF_WHISPER_TRANSCRIPTION_MODEL))
        SecureCredentialStore.open(context, "gateway").save("vck-phone")
        Account.syncAll(context)
        assertEquals("vck-phone", server.secret("secrets.gateway"))
    }

    @Test fun signingOutRevokesThisPhoneOnly() = runBlocking {
        pair()
        assertEquals("Signed out", Account.signOut(context))
        assertFalse(Account.isSignedIn(context))
        assertTrue(server.removed)
    }
}
