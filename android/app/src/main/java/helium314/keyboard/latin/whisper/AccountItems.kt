package helium314.keyboard.latin.whisper

import android.content.Context
import androidx.core.content.edit
import helium314.keyboard.latin.settings.Defaults
import helium314.keyboard.latin.settings.Settings
import helium314.keyboard.latin.utils.prefs
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.IOException

/**
 * Keeps the settings that mean the same on every device, and the API keys the phone uses, in step with the account, within
 * what the desktop granted this phone. The key is sealed with the account's secrets key (given to this phone only if
 * it was paired with API keys) before it leaves the device, so the server only ever stores ciphertext. Items this
 * phone does not use, such as the xAI key, are left untouched on the server. Mirrors desktop/item-sync.cjs.
 */
object AccountItems {
    private const val STORE = "account-items"
    const val PREF_CLEANUP_VARIANT = "whisper_cleanup_variant"
    private const val MODEL = "settings.transcriptionModel"
    private const val CLEANUP = "settings.cleanupMode"
    private const val RACE = "settings.raceMai"
    // Synced item name to the phone credential store holding it.
    private val SECRETS = mapOf("secrets.openrouter" to "openrouter", "secrets.gateway" to "gateway")
    val supportedModels = setOf("gpt-transcribe", "mai-transcribe-2-verbatim", "mai-transcribe-2-clean", GatewayStreamingSession.MODEL)

    private val mutex = Mutex()
    private class State(val base: MutableMap<String, VaultCrypto.Entry> = mutableMapOf())

    private var cached: State? = null
    internal fun resetForTests() { cached = null; lastMessage = "" }
    @Volatile var lastMessage = ""
        private set

    suspend fun sync(context: Context): String = mutex.withLock {
        val message = try { syncLocked(context) }
        catch (error: CancellationException) { throw error }
        catch (_: Account.SignedOut) { "" }
        catch (error: Exception) { (error.message?.takeIf { it.isNotBlank() } ?: "Sync failed") + ". Will retry." }
        lastMessage = message
        message
    }

    suspend fun forget(context: Context) = mutex.withLock {
        cached = State(); lastMessage = ""
        SecureCredentialStore.open(context, STORE).clear()
    }

    // --- saved state ---
    private fun load(context: Context): State = cached ?: run {
        val loaded = runCatching {
            val saved = JSONObject(SecureCredentialStore.open(context, STORE).load() ?: error("none"))
            val base = mutableMapOf<String, VaultCrypto.Entry>()
            saved.optJSONObject("base")?.let { entries -> entries.keys().forEach { name -> entries.getJSONObject(name).let { base[name] = VaultCrypto.Entry(if (it.isNull("d")) null else it.getString("d"), it.getLong("t")) } } }
            State(base)
        }.getOrDefault(State())
        loaded.also { cached = it }
    }

    private fun persist(context: Context, state: State) {
        val base = JSONObject()
        state.base.forEach { (name, entry) -> base.put(name, JSONObject().put("d", entry.digest ?: JSONObject.NULL).put("t", entry.updatedAt)) }
        check(SecureCredentialStore.open(context, STORE).save(JSONObject().put("base", base).toString())) { "Could not save sync progress" }
    }

    // --- one sync round ---
    private suspend fun syncLocked(context: Context): String {
        if (!Account.isSignedIn(context)) return ""
        val pulled = Account.request(context, "/sync/items", JSONObject().put("items", JSONArray()))
        Account.noteGrants(context, pulled.optJSONObject("grants"))
        val grants = Account.grants(context)
        val key = Account.keyFor(context, "secrets")
        val state = load(context)
        val remote = HashMap<String, JSONObject>()
        pulled.getJSONArray("items").let { items -> for (index in 0 until items.length()) items.getJSONObject(index).let { remote[it.getString("name")] = it } }
        val local = readLocal(context, includeKey = grants?.secrets == true && key != null)
        val now = System.currentTimeMillis()
        val pushes = mutableListOf<Triple<String, String?, Long>>()
        val pulls = LinkedHashMap<String, String?>()
        val pending = HashMap<String, VaultCrypto.Entry>()
        val nextBase = state.base.toMutableMap()
        val problems = mutableListOf<String>()
        val tracked = local.keys.filter { if (it.startsWith("secrets.")) grants?.secrets == true && key != null else grants?.settings == true }
        for (name in tracked) {
            val localValue = local[name]
            val item = remote[name]
            var remoteValue: String? = null
            var remoteEntry: VaultCrypto.Entry? = null
            if (item != null) {
                val deleted = item.getBoolean("deleted")
                if (!deleted) {
                    remoteValue = try { if (name.startsWith("secrets.")) VaultCrypto.open(key!!, name, item.getString("value")) else item.getString("value") }
                    catch (_: Exception) { problems.add(name); continue }
                }
                remoteEntry = VaultCrypto.Entry(if (deleted) null else VaultCrypto.digest(name, remoteValue), item.getLong("updatedAt"))
            }
            val decision = VaultCrypto.reconcile(VaultCrypto.digest(name, localValue), remoteEntry, state.base[name], now)
            when {
                decision.push != null -> pushes.add(Triple(name, localValue, decision.push))
                decision.pull -> { pulls[name] = remoteValue; pending[name] = decision.base!! }
                decision.base != null -> nextBase[name] = decision.base
                else -> nextBase.remove(name)
            }
        }
        if (pulls.isNotEmpty()) {
            val refused = writeLocal(context, pulls).toSet()
            for (name in pulls.keys) if (name !in refused) nextBase[name] = pending.getValue(name)
        }
        if (pushes.isNotEmpty()) {
            val items = JSONArray()
            for ((name, value, at) in pushes) {
                val item = JSONObject().put("name", name).put("updatedAt", at)
                if (value == null) item.put("value", "").put("deleted", true)
                else item.put("value", if (name.startsWith("secrets.")) VaultCrypto.seal(key!!, name, value) else value).put("deleted", false)
                items.put(item)
            }
            val confirmed = Account.request(context, "/sync/items", JSONObject().put("items", items))
            val stored = HashMap<String, Long>()
            confirmed.getJSONArray("items").let { array -> for (index in 0 until array.length()) array.getJSONObject(index).let { stored[it.getString("name")] = it.getLong("updatedAt") } }
            val rejected = confirmed.optJSONArray("rejected")?.let { array -> (0 until array.length()).map(array::getString) }.orEmpty()
            for ((name, value, at) in pushes) if (stored[name] == at && name !in rejected) nextBase[name] = VaultCrypto.Entry(VaultCrypto.digest(name, value), at)
        }
        state.base.clear(); state.base.putAll(nextBase)
        persist(context, state)
        return if (problems.isNotEmpty()) "Synced. Could not read ${problems.joinToString()}." else "Synced"
    }

    // --- this device's values ---
    private fun quoted(text: String) = "\"$text\""

    private fun readLocal(context: Context, includeKey: Boolean): Map<String, String?> {
        val prefs = context.prefs()
        val model = prefs.getString(Settings.PREF_WHISPER_TRANSCRIPTION_MODEL, Defaults.PREF_WHISPER_TRANSCRIPTION_MODEL)?.takeIf { it in supportedModels } ?: Defaults.PREF_WHISPER_TRANSCRIPTION_MODEL
        val cleanup = if (prefs.getBoolean(WhisperManager.PREF_LUNA_CLEANUP, false)) prefs.getString(PREF_CLEANUP_VARIANT, "luna")?.takeIf { it == "luna-fast" } ?: "luna" else "off"
        val values = mapOf(MODEL to quoted(model), CLEANUP to quoted(cleanup), RACE to prefs.getBoolean(WhisperManager.PREF_RACE_MAI, true).toString())
        if (!includeKey) return values
        return values + SECRETS.mapValues { (_, store) ->
            when (val stored = SecureCredentialStore.open(context, store).peek()) {
                is SecureCredentialStore.Peek.Value -> stored.key
                SecureCredentialStore.Peek.Empty -> null
                // A key that exists but cannot be read must not look like a deleted one.
                else -> throw IOException("Unlock the device to sync API keys")
            }
        }
    }

    /** Applies what another device changed and returns the names it could not use; those are retried later. */
    private fun writeLocal(context: Context, changes: Map<String, String?>): List<String> {
        val prefs = context.prefs()
        val refused = mutableListOf<String>()
        for ((name, value) in changes) {
            val text = value?.let { runCatching { JSONTokener(it).nextValue() }.getOrNull() }
            when (name) {
                MODEL -> if (text is String && text in supportedModels) prefs.edit { putString(Settings.PREF_WHISPER_TRANSCRIPTION_MODEL, text) } else refused.add(name)
                CLEANUP -> when (text) {
                    "off" -> prefs.edit { putBoolean(WhisperManager.PREF_LUNA_CLEANUP, false) }
                    "luna", "luna-fast" -> prefs.edit { putBoolean(WhisperManager.PREF_LUNA_CLEANUP, true); putString(PREF_CLEANUP_VARIANT, text as String) }
                    else -> refused.add(name)
                }
                RACE -> if (text is Boolean) prefs.edit { putBoolean(WhisperManager.PREF_RACE_MAI, text) } else refused.add(name)
                in SECRETS -> {
                    val store = SecureCredentialStore.open(context, SECRETS.getValue(name))
                    if (value == null) store.clear() else if (value.isBlank() || !store.save(value)) refused.add(name)
                }
                else -> refused.add(name)
            }
        }
        return refused
    }
}
