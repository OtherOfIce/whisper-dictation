# Android prototype notes

This prototype keeps WhisperBoard's full keyboard and microphone UI, but replaces its speech engines with one OpenRouter transcription path.

## Implemented

- Records mono AAC audio in an M4A container with Android `MediaRecorder`.
- Sends one JSON request to `https://openrouter.ai/api/v1/audio/transcriptions` using `openai/gpt-transcribe`.
- Cancels the HTTP call after 120 seconds and deletes the temporary recording after success, failure, or cancellation.
- Sends the preferred-term list through `provider.options.openai.keywords`. Input is limited to 1,000 terms, 120 characters per term, and 12,000 characters total.
- Encrypts the OpenRouter key with an app-owned Android Keystore AES key. Ciphertext is stored in credential-protected `noBackupFilesDir`. The manifest disables Android backup.
- Provides microphone permission, API-key, language, and preferred-term controls in the voice-input settings screen.
- Cancels recording and transcription when the editor changes, input finishes, or the keyboard hides. A monotonically increasing editor-session token guards final text insertion.
- Blocks voice input in password fields. A mic press during transcription cancels the request.
- Uses application ID `org.localwhisper.keyboard` and the name `Local Whisper Keyboard`.
- Disables personalized learning and removes the bundled Sherpa library plus Deepgram, Gemini, and Parakeet code paths.

## Known limits

- Android versions below 6.0 can use the keyboard but cannot store an OpenRouter key because the prototype requires Android Keystore AES-GCM.
- Device testing still needs to confirm that each manufacturer's `MediaRecorder` produces an M4A file accepted by OpenRouter.
- Recording stops at five minutes or 4 MiB. OpenRouter processing limits may require shorter dictation on slow connections.
- The inherited package namespace remains `helium314.keyboard` to avoid a large unrelated source move. The install identity and provider authority use the new package ID.
- The keyboard is unavailable before the first device unlock after boot so its API-key file always uses credential-protected storage.

## Build

Use JDK 17 or newer, Android SDK platform 36, Android build tools 35 or newer, and NDK `27.1.12297006`. Build the `debugNoMinify` variant for local device testing. Do not add an API key to Gradle files or source control.

WhisperBoard and HeliBoard license files and source notices remain in this checkout. The keyboard code is GPL-3.0, with inherited Apache-2.0 and CC BY-SA material documented by the existing license files.
