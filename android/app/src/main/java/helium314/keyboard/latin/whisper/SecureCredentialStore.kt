package helium314.keyboard.latin.whisper

import android.content.Context
import android.os.Build
import android.os.UserManager
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Where credentials live. Production uses the Android Keystore; tests swap in memory. */
interface CredentialStorage {
    fun load(): String?
    fun save(value: String): Boolean
    fun clear()
    fun peek(): SecureCredentialStore.Peek
}

class SecureCredentialStore(private val context: Context, private val name: String = "openrouter") : CredentialStorage {
    companion object {
        internal var factory: (Context, String) -> CredentialStorage = { context, name -> SecureCredentialStore(context, name) }
        fun open(context: Context, name: String = "openrouter"): CredentialStorage = factory(context, name)
    }
    private val alias = "local_whisper_${name}_key"
    fun isAvailable(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && isUserUnlocked()
    fun hasKey(): Boolean = !load().isNullOrBlank()

    sealed interface Peek {
        data object Unavailable : Peek
        data object Empty : Peek
        data object Unreadable : Peek
        data class Value(val key: String) : Peek
    }

    /** Tells "no key is saved" apart from "a key is saved but cannot be read right now", which load() reports alike. */
    override fun peek(): Peek {
        if (!isAvailable()) return Peek.Unavailable
        if (!credentialFile().isFile) return Peek.Empty
        return load()?.takeIf { it.isNotBlank() }?.let { Peek.Value(it) } ?: Peek.Unreadable
    }

    override fun load(): String? {
        if (!isAvailable()) return null
        return runCatching {
            val parts = credentialFile().takeIf(File::isFile)?.readText()?.split(':') ?: return null
            if (parts.size != 2) return null
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
            String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8)
        }.getOrNull()
    }

    override fun save(value: String): Boolean {
        if (!isAvailable() || value.isBlank()) return false
        return runCatching {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key())
            val iv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
            val encrypted = Base64.encodeToString(cipher.doFinal(value.trim().toByteArray()), Base64.NO_WRAP)
            val destination = credentialFile()
            check(destination.parentFile?.mkdirs() != false || destination.parentFile?.isDirectory == true)
            val temporary = File(destination.parentFile, "${destination.name}.tmp")
            temporary.writeText("$iv:$encrypted")
            check(temporary.renameTo(destination) || run { destination.delete(); temporary.renameTo(destination) })
            true
        }.getOrDefault(false)
    }

    override fun clear() {
        if (isUserUnlocked()) credentialFile().delete()
        runCatching { KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias) }
    }

    private fun isUserUnlocked() = Build.VERSION.SDK_INT < Build.VERSION_CODES.N ||
        context.getSystemService(UserManager::class.java)?.isUserUnlocked == true

    private fun credentialFile(): File {
        check(isUserUnlocked())
        return File(context.noBackupFilesDir, "$name-key.enc")
    }

    private fun key(): SecretKey {
        check(Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        return generator.generateKey()
    }
}
