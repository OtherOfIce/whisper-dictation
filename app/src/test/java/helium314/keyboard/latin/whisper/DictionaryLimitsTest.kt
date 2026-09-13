package helium314.keyboard.latin.whisper

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DictionaryLimitsTest {
    @Test
    fun appliesAllDictionaryBounds() {
        val input = (1..1_100).joinToString("\n") { "x".repeat(150) }
        assertTrue(DictionaryLimits.validate(input).error != null)
    }

    @Test
    fun trimsDropsBlanksAndDeduplicatesKeywords() {
        assertEquals(listOf("OpenRouter", "Local Whisper"), DictionaryLimits.validate(" OpenRouter \n\nopenrouter\nLocal Whisper").keywords)
    }
}
