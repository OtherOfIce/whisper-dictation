package helium314.keyboard.latin.whisper

import android.content.Context
import helium314.keyboard.latin.utils.prefs
import org.json.JSONObject
import java.io.File
import java.io.OutputStream
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** Temporary local diagnostics. No credentials or request bodies are recorded. */
class RecordingLogStore(private val directory: File) {
    fun begin(source: File, metadata: JSONObject): String = synchronized(lock) {
        require(source.length() <= AudioRecordingSpec.MAX_PCM_BYTES + 44L) { "Recording exceeds capture limit" }
        check(directory.mkdirs() || directory.isDirectory)
        val id = UUID.randomUUID().toString()
        val wav = File(directory, "$id.wav")
        val temporary = File(directory, "$id.wav.tmp")
        try {
            source.copyTo(temporary, overwrite = true)
            check(temporary.renameTo(wav))
            metadata.put("id", id).put("createdAt", System.currentTimeMillis()).put("outcome", "Transcribing")
            runCatching { WavDiagnostics.measure(wav) }.onSuccess { audio ->
                metadata.put("audio", JSONObject()
                    .put("sampleRate", audio.sampleRate).put("channels", audio.channels).put("bitsPerSample", audio.bitsPerSample)
                    .put("pcmBytes", audio.pcmBytes).put("durationSeconds", audio.durationSeconds)
                    .put("headerMatchesFile", audio.headerMatchesFile).put("peakDbfs", audio.peakDbfs)
                    .put("rmsDbfs", audio.rmsDbfs).put("clippedPercent", audio.clippedPercent).put("quietFramesPercent", audio.quietFramesPercent))
            }.onFailure { metadata.put("audioAnalysisError", it.javaClass.simpleName) }
            write(id, metadata)
            prune()
            id
        } catch (error: Exception) {
            wav.delete(); temporary.delete(); File(directory, "$id.json").delete(); File(directory, "$id.json.tmp").delete()
            throw error
        }
    }
    fun finish(id: String, outcome: String, rawText: String?, finalText: String?, elapsedMs: Long, errorType: String?) = synchronized(lock) {
        val file = File(directory, "$id.json")
        if (!file.isFile || !audioFile(id).isFile) return@synchronized
        val metadata = JSONObject(file.readText())
        metadata.put("outcome", outcome).put("requestElapsedMs", elapsedMs)
        if (rawText != null) metadata.put("rawTranscript", rawText)
        if (finalText != null) metadata.put("finalTranscript", finalText)
        if (errorType != null) metadata.put("errorType", errorType)
        write(id, metadata)
    }
    fun list(): List<JSONObject> = synchronized(lock) {
        directory.listFiles().orEmpty().filter { it.extension == "json" }.mapNotNull { file ->
            runCatching { JSONObject(file.readText()) }.getOrNull()?.takeIf { audioFile(it.getString("id")).isFile }
        }.sortedByDescending { it.optLong("createdAt") }
    }
    fun audioFile(id: String): File {
        require(id.matches(Regex("[a-f0-9-]{36}")))
        return File(directory, "$id.wav")
    }
    fun clear() = synchronized(lock) { directory.listFiles().orEmpty().forEach { it.delete() }; Unit }
    fun export(output: OutputStream) = synchronized(lock) {
        ZipOutputStream(output).use { zip ->
            directory.listFiles().orEmpty().filter { it.extension in listOf("wav", "json") }.sortedBy { it.name }.forEach { file ->
                zip.putNextEntry(ZipEntry(file.name)); file.inputStream().use { it.copyTo(zip) }; zip.closeEntry()
            }
        }
    }
    private fun write(id: String, metadata: JSONObject) {
        val file = File(directory, "$id.json")
        val temporary = File(directory, "$id.json.tmp")
        temporary.writeText(metadata.toString(2))
        check(temporary.renameTo(file))
    }
    private fun prune() {
        val records = list()
        var size = directory.listFiles().orEmpty().sumOf { it.length() }
        records.asReversed().forEachIndexed { index, record ->
            if (records.size - index > MAX_RECORDINGS || size > MAX_BYTES) {
                val id = record.getString("id")
                for (file in listOf(audioFile(id), File(directory, "$id.json"))) { size -= file.length(); file.delete() }
            }
        }
    }
    companion object {
        const val PREF_ENABLED = "whisper_recording_diagnostics"
        const val MAX_RECORDINGS = 10
        private const val MAX_BYTES = 50L * 1024 * 1024
        private val lock = Any()
        fun forContext(context: Context) = RecordingLogStore(File(context.noBackupFilesDir, "recording-diagnostics"))
        fun enabled(context: Context) = context.prefs().getBoolean(PREF_ENABLED, false)
    }
}
