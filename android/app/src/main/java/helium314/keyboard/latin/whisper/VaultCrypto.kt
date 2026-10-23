package helium314.keyboard.latin.whisper

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Crypto for account sync, byte-for-byte compatible with desktop/vault.cjs (both check the same vectors).
 *
 *   envelope = "v1." + base64(nonce, 12 bytes) + "." + base64(AES-256-GCM ciphertext || 16-byte tag)
 *   AAD      = "local-whisper:v1:" + item name, so the server cannot move a sealed value to another item
 *   pairing  = master PBKDF2-HMAC-SHA256(12-character code, "local-whisper:pair", 100000);
 *              pairId = hex(HMAC(master, "id")), key = HMAC(master, "key") opens the payload from the desktop
 *
 * Accounts and passphrases are Windows-only; this device only ever receives keys through a pairing payload.
 */
object VaultCrypto {
    const val PAIR_ITERATIONS = 100_000
    private const val PAIR_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    private val random = SecureRandom()
    private val base64 = Base64.getEncoder()

    class Pairing(val pairId: String, val key: ByteArray)
    data class Entry(val digest: String?, val updatedAt: Long)
    data class Decision(val push: Long? = null, val pull: Boolean = false, val base: Entry? = null)

    // Written out rather than using SecretKeyFactory, which only offers PBKDF2-HMAC-SHA256 from API 26 and may
    // encode the password differently. One 32-byte block is all the key needs.
    fun pbkdf2(password: ByteArray, salt: ByteArray, iterations: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(password, "HmacSHA256")) }
        mac.update(salt); mac.update(byteArrayOf(0, 0, 0, 1))
        var block = mac.doFinal()
        val result = block.copyOf()
        repeat(iterations - 1) {
            block = mac.doFinal(block)
            for (index in result.indices) result[index] = (result[index].toInt() xor block[index].toInt()).toByte()
        }
        return result
    }

    private fun hmac(key: ByteArray, label: String): ByteArray =
        Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key, "HmacSHA256")) }.doFinal(label.toByteArray(Charsets.UTF_8))

    /** Accepts what people type: any case, spaces or hyphens, and O/I/L for 0/1. Returns null if it cannot be a code. */
    fun normalizePairCode(value: String): String? {
        val code = value.uppercase().replace(Regex("[\\s-]"), "").replace('O', '0').replace('I', '1').replace('L', '1')
        return code.takeIf { it.length == 12 && it.all(PAIR_ALPHABET::contains) }
    }

    fun derivePairing(value: String, iterations: Int = PAIR_ITERATIONS): Pairing {
        val code = requireNotNull(normalizePairCode(value)) { "Enter the 12-character pairing code" }
        val master = pbkdf2(code.toByteArray(Charsets.UTF_8), "local-whisper:pair".toByteArray(Charsets.UTF_8), iterations)
        return Pairing(hmac(master, "id").joinToString("") { "%02x".format(it) }, hmac(master, "key"))
    }

    private fun aad(name: String) = "local-whisper:v1:$name".toByteArray(Charsets.UTF_8)

    fun seal(key: ByteArray, name: String, plaintext: String, nonce: ByteArray = ByteArray(12).also(random::nextBytes)): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(aad(name))
        return "v1.${base64.encodeToString(nonce)}.${base64.encodeToString(cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8)))}"
    }

    /** Throws if the envelope is damaged, was sealed with another key, or belongs to a different item. */
    fun open(key: ByteArray, name: String, envelope: String): String {
        val parts = envelope.split('.')
        require(parts.size == 3 && parts[0] == "v1" && parts[1].isNotEmpty() && parts[2].isNotEmpty()) { "Unsupported sealed value." }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, Base64.getDecoder().decode(parts[1])))
        cipher.updateAAD(aad(name))
        return String(cipher.doFinal(Base64.getDecoder().decode(parts[2])), Charsets.UTF_8)
    }

    /** Keeps API keys out of the saved bookkeeping; differs per item so equal values do not look alike. */
    fun digest(name: String, value: String?): String? = value?.let {
        MessageDigest.getInstance("SHA-256").digest("$name\n$it".toByteArray(Charsets.UTF_8)).joinToString("") { byte -> "%02x".format(byte) }
    }

    /**
     * Decides what one synced item needs from three views of it: this device's value (as a digest), the account's
     * latest, and the last state both agreed on. On first contact the account wins; afterwards a change made on this
     * device wins over one that arrived in the same interval, and otherwise the changed side wins. Mirrors reconcile()
     * in desktop/vault.cjs.
     */
    fun reconcile(local: String?, remote: Entry?, base: Entry?, now: Long): Decision {
        val pushAt = maxOf(now, (remote?.updatedAt ?: 0L) + 1)
        if (base == null) {
            if (remote?.digest != null) return Decision(pull = remote.digest != local, base = remote)
            if (local != null) return Decision(push = pushAt)
            return Decision(base = Entry(null, remote?.updatedAt ?: 0L))
        }
        if (local != base.digest) {
            if (remote != null && local == remote.digest) return Decision(base = remote)
            return Decision(push = pushAt)
        }
        if (remote != null && remote.updatedAt > base.updatedAt) return Decision(pull = remote.digest != local, base = remote)
        return Decision(base = base)
    }
}
