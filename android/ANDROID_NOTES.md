# Local Whisper Keyboard for Android

This branch ports Local Whisper onto HeliBoard 4.1. It keeps the current HeliBoard keyboard features and adds OpenRouter transcription to the native voice toolbar button.

## Implemented

- Tap the microphone button to start recording, then tap it again to upload the recording and insert the returned transcript at the cursor.
- Records mono 16 kHz PCM in a WAV file with Android `AudioRecord`.
- Sends audio to `https://openrouter.ai/api/v1/audio/transcriptions` using the selected model. MAI-Transcribe-2 Clean is the default. Two MAI requests race by default; the setting can be turned off because both requests may be billed.
- Retries transient request failures once and tries the other provider if transcription still fails. If all requests fail, one recording is kept in app-private no-backup storage. Tap the microphone to retry it in the current text field, or discard it in Voice input settings. Successful, cancelled, and discarded recordings are deleted.
- Optional Luna cleanup runs after transcription and defaults to off. If it fails, the original transcript is inserted. It does not read nearby editor text.
- Sends the personal dictionary through the selected provider's recognition-hint field. Input is limited to 1,000 terms, 120 characters per term, and 12,000 characters total.
- Encrypts the OpenRouter key with an app-owned Android Keystore AES key. Ciphertext stays in credential-protected `noBackupFilesDir`; Android backup is disabled.
- Keeps the API key in credential-protected storage and makes the keyboard available after the first device unlock following a reboot.
- Provides microphone permission, API key, language, and personal dictionary controls in the voice settings screen.
- Cancels recording and transcription when the editor changes, input finishes, or the keyboard hides. A monotonically increasing editor-session token guards final text insertion.
- Blocks voice input in password fields. A microphone tap during transcription cancels the request.
- Preserves HeliBoard's personalized dictionary and suggestion behavior.
- Uses application ID `org.localwhisper.keyboard` and the name `Local Whisper Keyboard`.

## Known limits

- Android versions below 6.0 can use the keyboard but cannot store an OpenRouter key because the app requires Android Keystore AES-GCM.
- Recording stops at five minutes or about 9.6 MiB of PCM. OpenRouter processing limits may require shorter dictation on slow connections.
- The inherited package namespace remains `helium314.keyboard` to avoid a broad source move. The install identity and provider authorities use the Local Whisper package ID.
- The keyboard is unavailable before the first device unlock after a reboot so the API-key file always uses credential-protected storage.

## Build

Use JDK 17 or newer, Android SDK platform 37, Android build tools 35 or newer, and NDK `28.0.13004108`. Build the `debugNoMinify` variant for local device testing. Never add an API key to Gradle files or source control.

HeliBoard's license files and source notices remain in this checkout. The keyboard code is GPL-3.0, with inherited Apache-2.0 and CC BY-SA material documented by the existing license files.
