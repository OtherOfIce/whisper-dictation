package helium314.keyboard.latin.whisper

import android.app.Application
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.util.zip.ZipInputStream

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], application = Application::class)
class RecordingLogStoreTest {
    @Test fun keepsExactAudioAndTranscriptThenExportsThem() {
        val directory = Files.createTempDirectory("whisper-logs").toFile()
        try {
            val store = RecordingLogStore(File(directory, "logs"))
            val source = File(directory, "source.wav")
            val bytes = AudioRecordingSpec.wavHeader(640) + ByteArray(640)
            source.writeBytes(bytes)
            val id = store.begin(source, JSONObject().put("requestedModel", "gpt-transcribe"))
            source.delete()
            store.finish(id, "Transcribed", "Bad result", "Cleaned result", 100, null)
            assertArrayEquals(bytes, store.audioFile(id).readBytes())
            val entry = store.list().single()
            assertEquals("Bad result", entry.getString("rawTranscript"))
            assertEquals("Cleaned result", entry.getString("finalTranscript"))
            assertEquals(100.0, entry.getJSONObject("audio").getDouble("quietFramesPercent"), 0.001)
            val output = ByteArrayOutputStream()
            store.export(output)
            val names = mutableListOf<String>()
            ZipInputStream(output.toByteArray().inputStream()).use { zip ->
                while (true) { val item = zip.nextEntry ?: break; names += item.name; if (item.name.endsWith(".wav")) assertArrayEquals(bytes, zip.readBytes()) }
            }
            assertEquals(setOf("$id.wav", "$id.json"), names.toSet())
            store.clear()
            store.finish(id, "Transcribed", "Late response", null, 200, null)
            assertTrue(store.list().isEmpty())
        } finally { directory.deleteRecursively() }
    }
    @Test fun boundsRetentionToTenRecordings() {
        val directory = Files.createTempDirectory("whisper-retention").toFile()
        try {
            val store = RecordingLogStore(File(directory, "logs"))
            val source = File(directory, "source.wav").apply { writeBytes(AudioRecordingSpec.wavHeader(640) + ByteArray(640)) }
            val ids = (0 until 11).map { store.begin(source, JSONObject()) }
            assertEquals(10, store.list().size)
            assertTrue(store.audioFile(ids.last()).exists())
            assertEquals(20, File(directory, "logs").listFiles()!!.size)
        } finally { directory.deleteRecursively() }
    }
}
