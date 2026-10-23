// SPDX-License-Identifier: GPL-3.0-only
package helium314.keyboard.settings.screens

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import helium314.keyboard.latin.R
import helium314.keyboard.latin.settings.Defaults
import helium314.keyboard.latin.settings.Settings
import helium314.keyboard.latin.utils.BackButton
import helium314.keyboard.latin.utils.prefs
import helium314.keyboard.latin.whisper.DictionaryLimits
import helium314.keyboard.latin.whisper.DictionarySync
import helium314.keyboard.latin.whisper.DictionaryChanges
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import helium314.keyboard.latin.whisper.Account
import helium314.keyboard.latin.whisper.SecureCredentialStore
import helium314.keyboard.latin.whisper.DictationAudioService
import helium314.keyboard.latin.whisper.WhisperManager
import helium314.keyboard.latin.whisper.MicrophoneInput
import helium314.keyboard.settings.Setting
import helium314.keyboard.settings.preferences.ListPreference

// This project's own Convex deployment, so signing in only needs an email address.
private const val DEFAULT_SYNC_URL = "https://rare-canary-989.convex.site"

@Composable
fun WhisperSettingsScreen(onClickBack: () -> Unit, onClickDiagnostics: () -> Unit = {}) {
    val context = LocalContext.current
    val prefs = context.prefs()
    val credentials = remember { SecureCredentialStore(context) }
    val gatewayCredentials = remember { SecureCredentialStore(context, "gateway") }
    var gatewayKey by remember { mutableStateOf("") }
    var gatewayStored by remember { mutableStateOf(gatewayCredentials.hasKey()) }
    var permissionGranted by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) }
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { permissionGranted = it }
    var pauseMedia by remember { mutableStateOf(prefs.getBoolean(DictationAudioService.PREF_PAUSE_MEDIA, true)) }
    var apiKey by remember { mutableStateOf("") }
    var keyStored by remember { mutableStateOf(credentials.hasKey()) }
    var keyError by remember { mutableStateOf<String?>(null) }
    var dictionary by remember { mutableStateOf(prefs.getString(Settings.PREF_WHISPER_DICTIONARY, "").orEmpty()) }
    var dictionaryError by remember { mutableStateOf<String?>(null) }
    val syncScope = rememberCoroutineScope()
    var syncUrl by remember { mutableStateOf(runCatching { DictionarySync.url(context) }.getOrDefault("").ifBlank { DEFAULT_SYNC_URL }) }
    var syncKey by remember { mutableStateOf("") }
    var signedIn by remember { mutableStateOf(runCatching { Account.isSignedIn(context) }.getOrDefault(false)) }
    var accountUser by remember { mutableStateOf(runCatching { Account.username(context) }.getOrDefault("")) }
    var accountDevice by remember { mutableStateOf(runCatching { Account.deviceName(context) }.getOrDefault("")) }
    var grants by remember { mutableStateOf(runCatching { Account.grants(context) }.getOrNull()) }
    var sharedKeyInUse by remember { mutableStateOf(runCatching { DictionarySync.usesSharedKey(context) }.getOrDefault(false)) }
    var showSharedKey by remember { mutableStateOf(false) }
    var pairCode by remember { mutableStateOf("") }
    var syncStatus by remember { mutableStateOf(if (syncUrl.isBlank()) "Sync is off" else "Waiting to sync") }
    var syncBusy by remember { mutableStateOf(false) }
    var raceMai by remember { mutableStateOf(prefs.getBoolean(WhisperManager.PREF_RACE_MAI, true)) }
    var lunaCleanup by remember { mutableStateOf(prefs.getBoolean(WhisperManager.PREF_LUNA_CLEANUP, false)) }
    var settingsVersion by remember { mutableIntStateOf(0) }
    var shownModel by remember { mutableStateOf(prefs.getString(Settings.PREF_WHISPER_TRANSCRIPTION_MODEL, Defaults.PREF_WHISPER_TRANSCRIPTION_MODEL)) }
    // Synced settings and the key can change underneath this screen, so reread what it shows.
    fun refreshAccountState() {
        signedIn = Account.isSignedIn(context)
        accountUser = Account.username(context); accountDevice = Account.deviceName(context); grants = Account.grants(context)
        sharedKeyInUse = DictionarySync.usesSharedKey(context)
        keyStored = credentials.hasKey()
        gatewayStored = gatewayCredentials.hasKey()
        raceMai = prefs.getBoolean(WhisperManager.PREF_RACE_MAI, true)
        lunaCleanup = prefs.getBoolean(WhisperManager.PREF_LUNA_CLEANUP, false)
        val model = prefs.getString(Settings.PREF_WHISPER_TRANSCRIPTION_MODEL, Defaults.PREF_WHISPER_TRANSCRIPTION_MODEL)
        if (model != shownModel) { shownModel = model; settingsVersion++ }
    }
    suspend fun syncTerms() {
        syncBusy = true
        val saved = prefs.getString(Settings.PREF_WHISPER_DICTIONARY, "").orEmpty()
        try {
            syncStatus = Account.syncAll(context)
            refreshAccountState()
            val updated = prefs.getString(Settings.PREF_WHISPER_DICTIONARY, "").orEmpty()
            if (dictionary == saved) dictionary = updated
            else if (updated != saved) {
                runCatching {
                    val pending = DictionaryChanges.changes(saved.split('\n'), dictionary.split('\n'))
                    DictionaryChanges.apply(updated.split('\n'), pending.first, pending.second).joinToString("\n")
                }.onSuccess { dictionary = it }
            }
        } finally { syncBusy = false }
    }
    LaunchedEffect(Unit) { while (true) { syncTerms(); delay(60_000) } }
    var failedRecordingPresent by remember { mutableStateOf(WhisperManager.failedRecording(context).isFile) }
    var secondaryMicrophone by remember { mutableStateOf(prefs.getBoolean(MicrophoneInput.PREF_SECONDARY, false)) }
    val secondaryMicrophoneAvailable = remember { MicrophoneInput.secondaryDevice(context) != null }

    Scaffold(topBar = { @OptIn(ExperimentalMaterial3Api::class) TopAppBar(
        title = { Text(stringResource(R.string.whisper_settings_title)) }, navigationIcon = { BackButton(onClickBack) })
    }) { padding ->
        Column(Modifier.padding(padding).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            Spacer(Modifier.height(12.dp))
            TextButton(onClick = onClickDiagnostics) { Text("Recording diagnostics") }
            Text(if (permissionGranted) "Microphone access granted" else "Microphone access is required")
            if (!permissionGranted) Button(onClick = { permissionLauncher.launch(Manifest.permission.RECORD_AUDIO) }) { Text("Grant microphone access") }
            Spacer(Modifier.height(12.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column(Modifier.weight(1f)) {
                    Text(stringResource(R.string.whisper_secondary_microphone_title), style = MaterialTheme.typography.titleSmall)
                    Text(stringResource(if (secondaryMicrophoneAvailable) R.string.whisper_secondary_microphone_description
                        else R.string.whisper_secondary_microphone_unavailable), style = MaterialTheme.typography.bodySmall)
                }
                Switch(checked = secondaryMicrophone, enabled = secondaryMicrophoneAvailable || secondaryMicrophone, onCheckedChange = {
                    secondaryMicrophone = it
                    prefs.edit { putBoolean(MicrophoneInput.PREF_SECONDARY, it) }
                })
            }
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = apiKey, onValueChange = { apiKey = it }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                label = { Text(stringResource(R.string.whisper_openrouter_api_key)) }, visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                supportingText = { Text(keyError ?: stringResource(when { !credentials.isAvailable() -> R.string.whisper_api_key_locked; keyStored -> R.string.whisper_api_key_stored; else -> R.string.whisper_api_key_missing })) },
                isError = keyError != null,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(enabled = apiKey.isNotBlank() && credentials.isAvailable(), onClick = {
                    if (credentials.save(apiKey)) { apiKey = ""; keyStored = true; keyError = null; syncScope.launch { syncTerms() } }
                    else keyError = "Could not encrypt and save the API key"
                }) { Text("Save key") }
                TextButton(enabled = keyStored, onClick = { credentials.clear(); keyStored = false; apiKey = ""; keyError = null; syncScope.launch { syncTerms() } }) { Text("Clear key") }
            }
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = gatewayKey, onValueChange = { gatewayKey = it }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                label = { Text("Vercel AI Gateway API key") }, visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                supportingText = { Text(when {
                    !gatewayCredentials.isAvailable() -> stringResource(R.string.whisper_api_key_locked)
                    gatewayStored -> "Saved. Used for MAI-Transcribe-2 · Streaming."
                    else -> "Needed for MAI-Transcribe-2 · Streaming. Syncs from your desktop when this phone has API keys."
                }) },
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(enabled = gatewayKey.isNotBlank() && gatewayCredentials.isAvailable(), onClick = {
                    if (gatewayCredentials.save(gatewayKey)) { gatewayKey = ""; gatewayStored = true; syncScope.launch { syncTerms() } }
                }) { Text("Save key") }
                TextButton(enabled = gatewayStored, onClick = { gatewayCredentials.clear(); gatewayStored = false; gatewayKey = ""; syncScope.launch { syncTerms() } }) { Text("Clear key") }
            }
            Spacer(Modifier.height(12.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column(Modifier.weight(1f)) {
                    Text("Pause media during dictation", style = MaterialTheme.typography.titleSmall)
                    Text("Ask other apps to pause until voice input finishes. Players control whether they resume. Shows a voice input notification while active.", style = MaterialTheme.typography.bodySmall)
                }
                Switch(checked = pauseMedia, onCheckedChange = {
                    pauseMedia = it
                    prefs.edit { putBoolean(DictationAudioService.PREF_PAUSE_MEDIA, it) }
                })
            }
            Spacer(Modifier.height(12.dp))
            LanguageSelector()
            Spacer(Modifier.height(12.dp))
            key(settingsVersion) { TranscriptionModelSelector { syncScope.launch { syncTerms() } } }
            Spacer(Modifier.height(12.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column(Modifier.weight(1f)) {
                    Text("Race two MAI requests", style = MaterialTheme.typography.titleSmall)
                    Text("Use the first result. Both requests may be billed.", style = MaterialTheme.typography.bodySmall)
                }
                Switch(checked = raceMai, onCheckedChange = {
                    raceMai = it
                    prefs.edit { putBoolean(WhisperManager.PREF_RACE_MAI, it) }
                    syncScope.launch { syncTerms() }
                })
            }
            Spacer(Modifier.height(12.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column(Modifier.weight(1f)) {
                    Text("Luna cleanup", style = MaterialTheme.typography.titleSmall)
                    Text("Remove false starts and spoken corrections before insertion. Adds a request and may change wording.", style = MaterialTheme.typography.bodySmall)
                }
                Switch(checked = lunaCleanup, onCheckedChange = {
                    lunaCleanup = it
                    prefs.edit { putBoolean(WhisperManager.PREF_LUNA_CLEANUP, it) }
                    syncScope.launch { syncTerms() }
                })
            }
            if (failedRecordingPresent) {
                Spacer(Modifier.height(12.dp))
                Text("A failed recording is saved on this device. Tap the microphone in a text field to retry it.")
                TextButton(onClick = {
                    WhisperManager.failedRecording(context).delete()
                    failedRecordingPresent = false
                }) { Text("Discard failed recording") }
            }
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = dictionary,
                onValueChange = { dictionary = it; dictionaryError = null },
                modifier = Modifier.fillMaxWidth().heightIn(min = 180.dp),
                label = { Text(stringResource(R.string.whisper_dictionary_title)) },
                supportingText = { Text(dictionaryError ?: stringResource(R.string.whisper_dictionary_hint)) },
                isError = dictionaryError != null,
            )
            Button(onClick = {
                val validation = DictionaryLimits.validate(dictionary)
                dictionaryError = validation.error
                if (validation.error == null) {
                    dictionary = validation.normalized
                    prefs.edit { putString(Settings.PREF_WHISPER_DICTIONARY, validation.normalized) }
                    syncScope.launch { syncTerms() }
                }
            }) { Text("Save preferred terms") }
            Spacer(Modifier.height(12.dp))
            Text("Account sync", style = MaterialTheme.typography.titleSmall)
            fun accountAction(failure: String, block: suspend () -> Unit) {
                syncScope.launch {
                    syncBusy = true
                    try { block() }
                    catch (error: CancellationException) { throw error }
                    catch (error: Exception) { syncStatus = error.message ?: failure }
                    finally { syncBusy = false }
                }
            }
            if (signedIn) {
                val parts = listOfNotNull("API keys".takeIf { grants?.secrets == true }, "voice settings".takeIf { grants?.settings == true }, grants?.dictionary?.let { "the $it dictionary" })
                val synced = if (parts.isEmpty()) "nothing yet" else parts.dropLast(1).joinToString().let { if (it.isEmpty()) parts.last() else "$it and ${parts.last()}" }
                Text("Paired as $accountDevice with $accountUser", style = MaterialTheme.typography.bodyMedium)
                Text("This phone syncs $synced. Change this from your desktop under Account and sync.", style = MaterialTheme.typography.bodySmall)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(enabled = !syncBusy, onClick = { syncScope.launch { syncTerms() } }) { Text("Sync now") }
                    TextButton(enabled = !syncBusy, onClick = { accountAction("Could not sign out") {
                        syncStatus = Account.signOut(context)
                        refreshAccountState()
                    } }) { Text("Sign out") }
                }
            } else {
                Text("Keep API keys, voice settings and a dictionary the same as your desktop. On a desktop signed in to Local Whisper, open Settings → Account and sync, choose Add device, and enter the code here.", style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(value = pairCode, onValueChange = { pairCode = it.take(20) }, label = { Text("Pairing code") }, placeholder = { Text("XXXX-XXXX-XXXX") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false), modifier = Modifier.fillMaxWidth())
                Button(enabled = !syncBusy && pairCode.isNotBlank(), onClick = { accountAction("Could not pair") {
                    syncStatus = "Pairing…"
                    Account.pair(context, syncUrl, pairCode)
                    pairCode = ""
                    refreshAccountState()
                    syncTerms()
                } }) { Text("Pair") }
                if (!showSharedKey && !sharedKeyInUse) TextButton(onClick = { showSharedKey = true }) { Text("Use a shared sync key instead") }
                if (showSharedKey || sharedKeyInUse) {
                    Text("Shared key (older setup, dictionary only)", style = MaterialTheme.typography.titleSmall)
                    OutlinedTextField(value = syncKey, onValueChange = { syncKey = it }, label = { Text("Shared sync key") }, supportingText = { Text("Leave blank to keep the saved key") }, visualTransformation = PasswordVisualTransformation(), singleLine = true, modifier = Modifier.fillMaxWidth())
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(enabled = !syncBusy, onClick = { accountAction("Could not save sync connection") {
                            DictionarySync.configure(context, syncUrl, syncKey); syncKey = ""
                            sharedKeyInUse = DictionarySync.usesSharedKey(context)
                            syncTerms()
                        } }) { Text("Connect") }
                        TextButton(enabled = !syncBusy && syncUrl.isNotBlank(), onClick = { syncScope.launch { syncTerms() } }) { Text("Sync now") }
                        TextButton(enabled = !syncBusy && syncUrl.isNotBlank(), onClick = { accountAction("Could not disconnect") {
                            DictionarySync.configure(context, "", ""); syncUrl = DEFAULT_SYNC_URL; syncKey = ""; sharedKeyInUse = false; showSharedKey = false; syncStatus = "Sync is off"
                        } }) { Text("Disconnect") }
                    }
                }
                OutlinedTextField(value = syncUrl, onValueChange = { syncUrl = it }, label = { Text("Server (Convex site URL)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            }
            Text(syncStatus, style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(12.dp))
            Text(stringResource(R.string.whisper_privacy_notice), style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun TranscriptionModelSelector(onChanged: () -> Unit) {
    val context = LocalContext.current
    val prefs = context.prefs()
    val items = listOf(
        "gpt-transcribe" to "GPT-Transcribe",
        "mai-transcribe-2-verbatim" to "MAI-Transcribe-2 · Verbatim",
        "mai-transcribe-2-clean" to "MAI-Transcribe-2 · Clean",
        "mai-transcribe-2-streaming" to "MAI-Transcribe-2 · Streaming",
    )
    var selected by remember {
        mutableStateOf(prefs.getString(Settings.PREF_WHISPER_TRANSCRIPTION_MODEL, Defaults.PREF_WHISPER_TRANSCRIPTION_MODEL)
            ?: Defaults.PREF_WHISPER_TRANSCRIPTION_MODEL)
    }
    Text(stringResource(R.string.whisper_transcription_model_title), style = MaterialTheme.typography.titleSmall)
    items.forEach { (value, label) ->
        Row {
            RadioButton(selected = selected == value, onClick = {
                selected = value
                prefs.edit { putString(Settings.PREF_WHISPER_TRANSCRIPTION_MODEL, value) }
                onChanged()
            })
            Text(label, modifier = Modifier.padding(top = 12.dp))
        }
    }
    Text(stringResource(R.string.whisper_transcription_model_hint), style = MaterialTheme.typography.bodySmall)
}

@Composable
private fun LanguageSelector() {
    val context = LocalContext.current
    val prefs = context.prefs()
    val items = listOf("auto", "en", "fr", "de", "nl")
    var selected by remember { mutableStateOf(prefs.getString(Settings.PREF_WHISPER_LANGUAGE, Defaults.PREF_WHISPER_LANGUAGE) ?: "auto") }
    Text(stringResource(R.string.whisper_language_title), style = MaterialTheme.typography.titleSmall)
    items.forEach { language ->
        Row {
            RadioButton(selected = selected == language, onClick = { selected = language; prefs.edit { putString(Settings.PREF_WHISPER_LANGUAGE, language) } })
            Text(if (language == "auto") "Auto-detect" else language.uppercase(), modifier = Modifier.padding(top = 12.dp))
        }
    }
}

fun createWhisperSettings(context: Context) = listOf(
    Setting(context, Settings.PREF_WHISPER_TRANSCRIPTION_MODEL, R.string.whisper_transcription_model_title) {
        ListPreference(it, listOf(
            "GPT-Transcribe" to "gpt-transcribe",
            "MAI-Transcribe-2 · Verbatim" to "mai-transcribe-2-verbatim",
            "MAI-Transcribe-2 · Clean" to "mai-transcribe-2-clean",
            "MAI-Transcribe-2 · Streaming" to "mai-transcribe-2-streaming",
        ), Defaults.PREF_WHISPER_TRANSCRIPTION_MODEL)
    },
    Setting(context, Settings.PREF_WHISPER_LANGUAGE, R.string.whisper_language_title) {
        ListPreference(it, listOf("Auto-detect" to "auto", "English" to "en", "Francais" to "fr", "Deutsch" to "de", "Nederlands" to "nl"), Defaults.PREF_WHISPER_LANGUAGE)
    },
)
