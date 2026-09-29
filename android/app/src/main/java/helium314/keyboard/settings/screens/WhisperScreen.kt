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
import helium314.keyboard.latin.whisper.SecureCredentialStore
import helium314.keyboard.latin.whisper.WhisperManager
import helium314.keyboard.settings.Setting
import helium314.keyboard.settings.preferences.ListPreference

@Composable
fun WhisperSettingsScreen(onClickBack: () -> Unit) {
    val context = LocalContext.current
    val prefs = context.prefs()
    val credentials = remember { SecureCredentialStore(context) }
    var permissionGranted by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) }
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { permissionGranted = it }
    var apiKey by remember { mutableStateOf("") }
    var keyStored by remember { mutableStateOf(credentials.hasKey()) }
    var keyError by remember { mutableStateOf<String?>(null) }
    var dictionary by remember { mutableStateOf(prefs.getString(Settings.PREF_WHISPER_DICTIONARY, "").orEmpty()) }
    var dictionaryError by remember { mutableStateOf<String?>(null) }
    var failedRecordingPresent by remember { mutableStateOf(WhisperManager.failedRecording(context).isFile) }
    var raceMai by remember { mutableStateOf(prefs.getBoolean(WhisperManager.PREF_RACE_MAI, true)) }
    var lunaCleanup by remember { mutableStateOf(prefs.getBoolean(WhisperManager.PREF_LUNA_CLEANUP, false)) }

    Scaffold(topBar = { @OptIn(ExperimentalMaterial3Api::class) TopAppBar(
        title = { Text(stringResource(R.string.whisper_settings_title)) }, navigationIcon = { BackButton(onClickBack) })
    }) { padding ->
        Column(Modifier.padding(padding).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            Spacer(Modifier.height(12.dp))
            Text(if (permissionGranted) "Microphone access granted" else "Microphone access is required")
            if (!permissionGranted) Button(onClick = { permissionLauncher.launch(Manifest.permission.RECORD_AUDIO) }) { Text("Grant microphone access") }
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
                    if (credentials.save(apiKey)) { apiKey = ""; keyStored = true; keyError = null }
                    else keyError = "Could not encrypt and save the API key"
                }) { Text("Save key") }
                TextButton(enabled = keyStored, onClick = { credentials.clear(); keyStored = false; apiKey = ""; keyError = null }) { Text("Clear key") }
            }
            Spacer(Modifier.height(12.dp))
            LanguageSelector()
            Spacer(Modifier.height(12.dp))
            TranscriptionModelSelector()
            Spacer(Modifier.height(12.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column(Modifier.weight(1f)) {
                    Text("Race two MAI requests", style = MaterialTheme.typography.titleSmall)
                    Text("Use the first result. Both requests may be billed.", style = MaterialTheme.typography.bodySmall)
                }
                Switch(checked = raceMai, onCheckedChange = {
                    raceMai = it
                    prefs.edit { putBoolean(WhisperManager.PREF_RACE_MAI, it) }
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
                }
            }) { Text("Save preferred terms") }
            Spacer(Modifier.height(12.dp))
            Text(stringResource(R.string.whisper_privacy_notice), style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun TranscriptionModelSelector() {
    val context = LocalContext.current
    val prefs = context.prefs()
    val items = listOf(
        "gpt-transcribe" to "GPT-Transcribe",
        "mai-transcribe-2-verbatim" to "MAI-Transcribe-2 · Verbatim",
        "mai-transcribe-2-clean" to "MAI-Transcribe-2 · Clean",
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
        ), Defaults.PREF_WHISPER_TRANSCRIPTION_MODEL)
    },
    Setting(context, Settings.PREF_WHISPER_LANGUAGE, R.string.whisper_language_title) {
        ListPreference(it, listOf("Auto-detect" to "auto", "English" to "en", "Francais" to "fr", "Deutsch" to "de", "Nederlands" to "nl"), Defaults.PREF_WHISPER_LANGUAGE)
    },
)
