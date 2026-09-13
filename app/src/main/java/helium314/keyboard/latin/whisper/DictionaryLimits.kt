package helium314.keyboard.latin.whisper

object DictionaryLimits {
    const val MAX_TERMS = 1_000
    const val MAX_TERM_LENGTH = 120
    const val MAX_TOTAL_LENGTH = 12_000

    fun validate(value: String): DictionaryValidation {
        val normalized = value.replace("\r\n", "\n").replace('\r', '\n')
        if (normalized.length > MAX_TOTAL_LENGTH) return DictionaryValidation(error = "Preferred terms exceed 12,000 characters")
        val lines = normalized.split('\n')
        if (lines.size > MAX_TERMS) return DictionaryValidation(error = "Preferred terms exceed 1,000 lines")
        if (lines.any { it.length > MAX_TERM_LENGTH }) return DictionaryValidation(error = "Each preferred term must be 120 characters or fewer")
        val seen = HashSet<String>()
        val terms = lines.map(String::trim).filter(String::isNotEmpty).filter { seen.add(it.lowercase()) }
        return DictionaryValidation(normalized = normalized, keywords = terms)
    }
}

data class DictionaryValidation(
    val normalized: String = "",
    val keywords: List<String> = emptyList(),
    val error: String? = null,
)
