package helium314.keyboard.latin.whisper

import helium314.keyboard.latin.whisper.VaultCrypto.Decision
import helium314.keyboard.latin.whisper.VaultCrypto.Entry
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

// The vectors are the same ones desktop/tests/vault.test.cjs asserts. Change one side and the other must follow.
@RunWith(RobolectricTestRunner::class)
class VaultCryptoTest {
    private val keyHex = "7c2970c29d1bc08f5a224ef541f346aa5addc83a324b52cd15d94af49939e521"
    private val nonce = "a0a1a2a3a4a5a6a7a8a9aaab".chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    private val envelope = "v1.oKGio6Slpqeoqaqr.F/CGK5eGYE7T/1iGQXPx3ceFsoibx2pT4mOLQtA="
    private val unicodeEnvelope = "v1.oKGio6Slpqeoqaqr.D1gCPchoqlIOFKlk0fE0+WcKY7LVMpEanw1WeA=="
    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
    private val key = keyHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    @Test fun sealsToTheSharedEnvelope() {
        assertEquals(envelope, VaultCrypto.seal(key, "secrets.openrouter", "sk-or-v1-test", nonce))
        assertEquals(unicodeEnvelope, VaultCrypto.seal(key, "secrets.xai", "kéy-ü-🔑", nonce))
        assertEquals("sk-or-v1-test", VaultCrypto.open(key, "secrets.openrouter", envelope))
        assertEquals("kéy-ü-🔑", VaultCrypto.open(key, "secrets.xai", unicodeEnvelope))
    }

    @Test fun derivesThePairingKeysLikeTheDesktopAndOpensItsPayload() {
        val pairing = VaultCrypto.derivePairing("7k3m-q9xz-04ab")
        assertEquals("552b3fb0263a87d952ba66d4fac15d00ea10b8d96a725d845ae380f5626f38ce", pairing.pairId)
        assertEquals("cf2a993e37b4b2a15878b330bbb2f23d00fddc53e0f7ee4e12cc0c0ec9ff7e8d", hex(pairing.key))
        val payload = "v1.oKGio6Slpqeoqaqr.6UMglo0VqWH52jJRDPHzpI2sG77PkAavngTcwlwSHFtPpyvrureSLD/LqtfJ2/t8ACCivDgD3grP87W3pLBXSN8Dg2DkR91U549y5NnZuAbDJlpuiByskw08LWUmhudrEzg="
        assertEquals("""{"v":1,"keyring":{"v":1,"secrets":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="}}""", VaultCrypto.open(pairing.key, "pairing", payload))
        assertFailsWith<Exception> { VaultCrypto.open(VaultCrypto.derivePairing("7k3m-q9xz-04ac").key, "pairing", payload) }
    }

    @Test fun pairingCodesAreReadTheWayPeopleTypeThem() {
        assertEquals("7K3MQ9XZ04AB", VaultCrypto.normalizePairCode(" 7k3m q9xz-04ab "))
        assertEquals("011100000000", VaultCrypto.normalizePairCode("o1il-0000-0000"))
        for (bad in listOf("", "7K3M-Q9XZ-04A", "7K3M-Q9XZ-04ABC", "UUUU-UUUU-UUUU")) assertEquals(null, VaultCrypto.normalizePairCode(bad))
        assertFailsWith<IllegalArgumentException> { VaultCrypto.derivePairing("nope") }
    }

    @Test fun aSealedValueOnlyOpensWithItsKeyAndItsOwnName() {
        assertFailsWith<Exception> { VaultCrypto.open(key, "secrets.xai", envelope) }
        assertFailsWith<Exception> { VaultCrypto.open(ByteArray(32) { 1 }, "secrets.openrouter", envelope) }
        val last = envelope.last()
        assertFailsWith<Exception> { VaultCrypto.open(key, "secrets.openrouter", envelope.dropLast(1) + if (last == 'A') 'B' else 'A') }
        for (bad in listOf("", "v2.a.b", "v1.a", "v1..b")) assertFailsWith<Exception> { VaultCrypto.open(key, "secrets.openrouter", bad) }
        assertNotEquals(VaultCrypto.seal(key, "secrets.openrouter", "x"), VaultCrypto.seal(key, "secrets.openrouter", "x"))
    }

    @Test fun digestsKeepValuesOutOfBookkeeping() {
        assertEquals(null, VaultCrypto.digest("a", null))
        assertNotEquals(VaultCrypto.digest("a", "k"), VaultCrypto.digest("b", "k"))
        assertTrue(!VaultCrypto.digest("a", "sk-secret")!!.contains("secret"))
    }

    @Test fun reconcileDecidesWhatToSendTakeOrLeave() {
        val now = 10_000L
        fun d(value: String?) = VaultCrypto.digest("x", value)
        fun entry(value: String?, at: Long) = Entry(d(value), at)
        data class Case(val label: String, val local: String?, val remote: Entry?, val base: Entry?, val expected: Decision)
        val cases = listOf(
            Case("first contact, account has a value", d("A"), entry("B", 500), null, Decision(pull = true, base = entry("B", 500))),
            Case("first contact, same value", d("A"), entry("A", 500), null, Decision(pull = false, base = entry("A", 500))),
            Case("first contact, nothing in the account", d("A"), null, null, Decision(push = now)),
            Case("first contact, account value was deleted", d("A"), entry(null, 500), null, Decision(push = now)),
            Case("first contact, nothing anywhere", null, null, null, Decision(base = entry(null, 0))),
            Case("first contact, empty here, account deleted", null, entry(null, 500), null, Decision(base = entry(null, 500))),
            Case("nothing changed", d("A"), entry("A", 500), entry("A", 500), Decision(base = entry("A", 500))),
            Case("edited here", d("B"), entry("A", 500), entry("A", 500), Decision(push = now)),
            Case("deleted here", null, entry("A", 500), entry("A", 500), Decision(push = now)),
            Case("edited elsewhere", d("A"), entry("B", 800), entry("A", 500), Decision(pull = true, base = entry("B", 800))),
            Case("deleted elsewhere", d("A"), entry(null, 800), entry("A", 500), Decision(pull = true, base = entry(null, 800))),
            Case("both edited, this device wins", d("C"), entry("B", 800), entry("A", 500), Decision(push = now)),
            Case("both reached the same value", d("B"), entry("B", 800), entry("A", 500), Decision(base = entry("B", 800))),
            Case("edited here with a clock behind the account", d("B"), entry("A", 99_999), entry("A", 500), Decision(push = 100_000)),
            Case("nothing changed, no remote record", d("A"), null, entry("A", 500), Decision(base = entry("A", 500))),
        )
        for (case in cases) assertEquals(case.expected, VaultCrypto.reconcile(case.local, case.remote, case.base, now), case.label)
    }
}
