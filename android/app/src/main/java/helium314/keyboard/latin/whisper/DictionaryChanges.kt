package helium314.keyboard.latin.whisper

object DictionaryChanges {
    fun normalize(terms: List<String>): List<String> {
        require(terms.none { '\n' in it || '\r' in it }) { "Invalid dictionary terms" }
        val result = terms.map(String::trim).filter(String::isNotEmpty).associateBy { it.lowercase() }.values.toList()
        require(result.size <= 1000 && result.none { it.length > 120 } && result.joinToString("\n").length <= 12000) { "Dictionary exceeds app limits" }
        return result
    }
    fun changes(base: List<String>, current: List<String>): Pair<List<String>, List<String>> {
        val before = normalize(base).associateBy { it.lowercase() }
        val after = normalize(current).associateBy { it.lowercase() }
        return after.filter { (key, term) -> before[key] != term }.values.toList() to before.keys.filter { it !in after }
    }
    fun apply(terms: List<String>, add: List<String>, remove: List<String>): List<String> {
        val map = normalize(terms).associateBy { it.lowercase() }.toMutableMap()
        remove.forEach { map.remove(it.lowercase()) }
        add.forEach { map[it.lowercase()] = it }
        return normalize(map.values.toList())
    }
}
