package helium314.keyboard.settings.screens

import android.media.MediaPlayer
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import helium314.keyboard.latin.utils.BackButton
import helium314.keyboard.latin.utils.prefs
import helium314.keyboard.latin.whisper.RecordingLogStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.text.DateFormat
import java.util.Date
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RecordingDiagnosticsScreen(onClickBack: () -> Unit) {
    val context = LocalContext.current
    val store = remember { RecordingLogStore.forContext(context) }
    val scope = rememberCoroutineScope()
    var enabled by remember { mutableStateOf(RecordingLogStore.enabled(context)) }
    var records by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var notice by remember { mutableStateOf("") }
    var playing by remember { mutableStateOf<String?>(null) }
    var player by remember { mutableStateOf<MediaPlayer?>(null) }
    var expanded by remember { mutableStateOf<String?>(null) }
    suspend fun refresh() { records = withContext(Dispatchers.IO) { store.list() } }
    fun stopPlayback() { player?.release(); player = null; playing = null }
    LaunchedEffect(Unit) { refresh() }
    DisposableEffect(Unit) { onDispose { player?.release() } }
    val export = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/zip")) { uri ->
        if (uri != null) scope.launch {
            notice = try {
                withContext(Dispatchers.IO) {
                    context.contentResolver.openOutputStream(uri)?.use { store.export(it) } ?: error("Could not open export file")
                }
                "Recordings exported"
            } catch (_: Exception) { "Could not export recordings" }
        }
    }
    Scaffold(topBar = { TopAppBar(title = { Text("Recording diagnostics") }, navigationIcon = { BackButton(onClickBack) }) }) { padding ->
        Column(Modifier.padding(padding).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column(Modifier.weight(1f)) {
                    Text("Save recordings temporarily", style = MaterialTheme.typography.titleSmall)
                    Text("Keep the latest 10 recordings and their transcripts on this phone, up to 50 MB. Turn off after investigating.", style = MaterialTheme.typography.bodySmall)
                }
                Switch(checked = enabled, onCheckedChange = {
                    enabled = it
                    context.prefs().edit().putBoolean(RecordingLogStore.PREF_ENABLED, it).apply()
                })
            }
            Text("These are copies of the WAV files sent for transcription. They are stored privately, outside backups, and are not uploaded to Convex.", style = MaterialTheme.typography.bodySmall)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = { scope.launch { refresh() } }) { Text("Refresh") }
                TextButton(enabled = records.isNotEmpty(), onClick = { export.launch("whisper-recording-diagnostics.zip") }) { Text("Export ZIP") }
                TextButton(enabled = records.isNotEmpty(), onClick = {
                    stopPlayback()
                    scope.launch { withContext(Dispatchers.IO) { store.clear() }; refresh(); notice = "Saved recordings deleted" }
                }) { Text("Clear recordings") }
            }
            if (notice.isNotEmpty()) Text(notice)
            if (records.isEmpty()) Text("No recordings saved yet. Enable saving, then dictate a phrase in a text field.")
            records.forEach { record ->
                val id = record.getString("id")
                val audio = record.optJSONObject("audio")
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.MEDIUM).format(Date(record.getLong("createdAt"))), style = MaterialTheme.typography.titleSmall)
                        Text("${record.optString("outcome")} · ${record.optString("requestedModel")}")
                        if (audio != null) {
                            fun number(name: String) = String.format(Locale.ROOT, "%.1f", audio.optDouble(name))
                            Text("${number("durationSeconds")} s · ${audio.optInt("sampleRate")} Hz · Mono PCM16")
                            Text("Average ${number("rmsDbfs")} dBFS · Peak ${number("peakDbfs")} dBFS")
                            Text("Clipped ${number("clippedPercent")}% · Quiet frames ${number("quietFramesPercent")}%")
                            if (!audio.optBoolean("headerMatchesFile")) Text("Warning: WAV header does not match the file length")
                        } else Text("Audio measurements unavailable")
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(onClick = {
                                if (playing == id) stopPlayback()
                                else {
                                    stopPlayback()
                                    try {
                                        val current = MediaPlayer()
                                        player = current
                                        current.setDataSource(store.audioFile(id).absolutePath)
                                        current.setOnCompletionListener { stopPlayback() }
                                        current.setOnErrorListener { _, _, _ -> stopPlayback(); notice = "Could not play recording"; true }
                                        current.prepare(); current.start()
                                        playing = id
                                    } catch (_: Exception) { stopPlayback(); notice = "Could not play recording" }
                                }
                            }) { Text(if (playing == id) "Stop" else "Play recording") }
                            TextButton(onClick = { expanded = if (expanded == id) null else id }) { Text(if (expanded == id) "Hide details" else "Details") }
                        }
                        if (expanded == id) {
                            Text("Raw transcript", style = MaterialTheme.typography.titleSmall)
                            Text(record.optString("rawTranscript", "No transcript returned"))
                            if (record.has("finalTranscript") && record.optString("finalTranscript") != record.optString("rawTranscript")) {
                                Text("After cleanup", style = MaterialTheme.typography.titleSmall)
                                Text(record.getString("finalTranscript"))
                            }
                            Text("Language: ${record.optString("language")} · Dictionary terms: ${record.optInt("dictionaryTermCount")}")
                            Text("MAI race: ${record.optBoolean("raceMai")} · Cleanup: ${record.optBoolean("cleanupEnabled")} · Retry: ${record.optBoolean("manualRetry")}")
                            record.optJSONObject("capture")?.let { capture ->
                                Text("Microphone: ${capture.optString("source")} · Reported rate: ${capture.optInt("reportedSampleRate")} Hz")
                                Text("Capture time: ${capture.optLong("captureElapsedMs")} ms · Writer finished: ${capture.optBoolean("writerFinished")}")
                                if (capture.has("inputDeviceName")) Text("Input: ${capture.optString("inputDeviceName")}")
                                if (capture.has("readErrorType")) Text("Capture error: ${capture.getString("readErrorType")}")
                            }
                            if (record.has("errorType")) Text("Request error: ${record.getString("errorType")}")
                        }
                    }
                }
            }
        }
    }
}
