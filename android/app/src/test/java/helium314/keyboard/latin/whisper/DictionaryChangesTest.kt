package helium314.keyboard.latin.whisper

import org.junit.Assert.assertEquals
import org.junit.Test

class DictionaryChangesTest {
    @Test fun offlineEditsMergeAndDeletionsPersist() {
        val base = listOf("Astra", "Old")
        val desktop = DictionaryChanges.changes(base, listOf("ASTRA", "Desktop"))
        val phone = DictionaryChanges.changes(base, base + "Phone")
        val server = DictionaryChanges.apply(DictionaryChanges.apply(base, desktop.first, desktop.second), phone.first, phone.second)
        assertEquals(listOf("ASTRA", "Desktop", "Phone"), server)
        assertEquals(emptyList<String>() to emptyList<String>(), DictionaryChanges.changes(server, server))
    }
    @Test(expected = IllegalArgumentException::class) fun rejectsOversizedMerge() {
        DictionaryChanges.apply((0 until 1000).map(Int::toString), listOf("extra"), emptyList())
    }
}
