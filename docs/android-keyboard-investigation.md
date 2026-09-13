# Android keyboard investigation

Date: 2026-09-12. Inspected [`david-digitis/WhisperBoard`](https://github.com/david-digitis/WhisperBoard) at [`dc2d785`](https://github.com/david-digitis/WhisperBoard/commit/dc2d78558179015371eb9bb7a48e3ef1185088e4).

## Recommendation

Fork WhisperBoard for the Android prototype. It is a native Android/Kotlin full keyboard based on HeliBoard. It already has the expensive pieces: a microphone button, `AudioRecord` capture, recording state UI, cloud and local STT routing, settings, and final insertion through `InputConnection`. Keep the new OpenRouter code in its own package so it can be moved onto a newer HeliBoard base later.

Do not publish the fork unchanged. Give it a new package and signing identity, fix microphone permission and key storage, remove transcript logging, and prevent late network responses from inserting text into a newly focused app.

## What the source contains

The manifest exports `LatinIME` as an `InputMethodService` and requests `BIND_INPUT_METHOD`. Gradle targets API 35 with a minimum of API 21. The app still uses HeliBoard's `helium314.keyboard` application ID, so it cannot normally coexist with the official HeliBoard build signed by another developer. [Manifest](https://github.com/david-digitis/WhisperBoard/blob/dc2d78558179015371eb9bb7a48e3ef1185088e4/app/src/main/AndroidManifest.xml), [WhisperBoard Gradle configuration](https://github.com/david-digitis/WhisperBoard/blob/dc2d78558179015371eb9bb7a48e3ef1185088e4/app/build.gradle.kts), [current HeliBoard configuration](https://github.com/HeliBorg/HeliBoard/blob/main/app/build.gradle.kts).

`AudioRecorder` records 16 kHz mono PCM16. `WhisperManager` streams cloud audio over a Deepgram WebSocket and accumulates samples for local transcription. Local transcription now uses Parakeet TDT v3 through sherpa-onnx. The README is stale: it still describes whisper.cpp and three Whisper models removed in April 2026. [AudioRecorder](https://github.com/david-digitis/WhisperBoard/blob/dc2d78558179015371eb9bb7a48e3ef1185088e4/app/src/main/java/helium314/keyboard/latin/whisper/AudioRecorder.kt), [WhisperManager](https://github.com/david-digitis/WhisperBoard/blob/dc2d78558179015371eb9bb7a48e3ef1185088e4/app/src/main/java/helium314/keyboard/latin/whisper/WhisperManager.kt), [Parakeet migration](https://github.com/david-digitis/WhisperBoard/commit/dcf40ff2).

The insertion path already uses the right Android mechanism. `LatinIME` finishes composition and calls `commitText(text, 1)`. Android defines `InputConnection` as the channel between an IME and the focused editor. [LatinIME integration](https://github.com/david-digitis/WhisperBoard/blob/dc2d78558179015371eb9bb7a48e3ef1185088e4/app/src/main/java/helium314/keyboard/latin/LatinIME.java#L553-L568), [Android InputConnection reference](https://developer.android.com/reference/android/view/inputmethod/InputConnection.html).

Maintenance is recent but comes from one short burst. Voice work landed in March and April 2026, release 3.8 followed on 27 April, and the last inspected commit is 15 May. Upstream HeliBoard is already at 4.1/API 37. Regular upstream merges will be part of maintaining this fork. [WhisperBoard commits](https://github.com/david-digitis/WhisperBoard/commits/main/), [HeliBoard](https://github.com/HeliBorg/HeliBoard).

## OpenRouter port

OpenRouter GPT Transcribe uses a completed file request, unlike the existing Deepgram streaming socket:

```text
PCM16 -> compressed audio -> OpenRouter GPT Transcribe
      -> optional Luna cleanup -> finishComposingText + commitText
```

On mic release, encode the recording with an Android-supported compressed format that OpenRouter accepts, then send it as base64 to `/api/v1/audio/transcriptions` with model `openai/gpt-transcribe`. Verify the chosen encoder and its output on real devices. Use WAV only for short, bounded smoke tests: the desktop investigation found that uncompressed uploads timed out on longer samples, while MP3 solved the upload problem. OpenRouter also recommends compressed audio and splitting large recordings around its upstream 60-second processing limit. [OpenRouter STT documentation](https://openrouter.ai/docs/guides/overview/multimodal/stt), [desktop performance investigation](performance-investigation.md), [existing desktop client](../src/LocalWhisper/Transcriber.cs).

Send the preferred-term dictionary through the tested `provider.options.openai.keywords` field. Keep the list bounded and treat hints as best effort. No extra request is needed. [Hints test](openrouter-hints-test.md), [dictionary plan](dictionary-plan.md).

Keep Luna optional and add it after basic transcription works. Port the existing `off`, `luna`, and `luna-fast` modes and prompt. Use a timeout and paste the original transcript if cleanup fails, returns empty output, or truncates the response. Luna adds a second serial request, so show it as a separate processing stage. The Windows measurements put the combined median near 1.6 to 1.8 seconds on the test set, but Android and mobile-network latency still need measurement. [Cleanup client](../src/LocalWhisper/CleanupService.cs), [Luna measurements](luna-wispr-investigation.md).

## Release blockers

1. Change `applicationId`, the file-provider authority, app name, URLs, and signing key. Remove the literal release-store passwords currently present in Gradle.
2. Add an in-context `RECORD_AUDIO` permission request. The repository declares and checks the permission, but its only runtime permission launcher requests contacts. Android requires dangerous permissions at runtime on API 23 and later. [Permission check](https://github.com/david-digitis/WhisperBoard/blob/dc2d78558179015371eb9bb7a48e3ef1185088e4/app/src/main/java/helium314/keyboard/latin/whisper/WhisperManager.kt#L137-L144), [Android permission workflow](https://developer.android.com/training/permissions/requesting).
3. Encrypt the OpenRouter key using an app-owned Android Keystore key. WhisperBoard currently puts cloud keys in device-protected `SharedPreferences`; its own helper says that store must not hold sensitive data. The app also enables backup, and Android backs up shared preferences by default. Store ciphertext after unlock and exclude it from cloud and device-transfer backups. [Preference helper](https://github.com/david-digitis/WhisperBoard/blob/dc2d78558179015371eb9bb7a48e3ef1185088e4/app/src/main/java/helium314/keyboard/latin/utils/Ktx.kt#L87-L92), [Android key guidance](https://developer.android.com/privacy-and-security/security-tips), [Android backup behavior](https://developer.android.com/identity/data/autobackup).
4. Remove transcript text from `whisper_debug.log`. Keep timings, byte counts, request IDs, and error classes only. [FileLogger](https://github.com/david-digitis/WhisperBoard/blob/dc2d78558179015371eb9bb7a48e3ef1185088e4/app/src/main/java/helium314/keyboard/latin/whisper/FileLogger.kt), [transcript logging](https://github.com/david-digitis/WhisperBoard/blob/dc2d78558179015371eb9bb7a48e3ef1185088e4/app/src/main/java/helium314/keyboard/latin/whisper/WhisperManager.kt#L162-L165).
5. Give each recording an editor-session token. Cancel work in `onFinishInput` and discard results when focus or session changes. This prevents a slow response from being committed into another app's field.
6. Disable recording and Luna in password fields. Android's IME guide says keyboards must not store or expose password input. [Android IME guide](https://developer.android.com/develop/ui/views/touch-and-input/creating-input-method).

The privacy screen should state that GPT Transcribe sends audio and preferred-term hints to OpenRouter and its serving provider. Luna also sends the transcript and any glossary supplied to it. Cancelling can stop future transfer but cannot retract audio already uploaded.

## Fork or standalone voice IME

A standalone voice IME is technically valid, and FUTO Voice Input demonstrates the speech intent and `voice` subtype approaches. Android allows only one active IME, so the user must switch away from their keyboard while dictating. That loses the integrated mic-button experience this project wants. [Android IME guide](https://developer.android.com/develop/ui/views/touch-and-input/creating-input-method), [FUTO Voice Input](https://github.com/futo-org/voice-input).

Starting from current HeliBoard gives a newer base, but it requires transplanting WhisperBoard's recorder, UI, coordinator, and settings. That makes sense for a long-lived public product, not the fastest prototype.

FUTO Voice Input's Source First 1.0 license limits modification and distribution to non-commercial use and requires payment functionality to remain. It does not fit a project that wants normal open-source redistribution rights. [FUTO license](https://github.com/futo-org/voice-input/blob/master/LICENSE.md).

WhisperBoard and HeliBoard use GPL-3.0 for the keyboard, with Apache-2.0 AOSP material and a CC BY-SA icon. A distributed APK needs corresponding source for the GPL-covered build, preserved notices, and the relevant asset attribution. Publish source from the same release tag as the APK. [WhisperBoard license](https://github.com/david-digitis/WhisperBoard/blob/dc2d78558179015371eb9bb7a48e3ef1185088e4/README.md#license), [GPL text](https://github.com/david-digitis/WhisperBoard/blob/dc2d78558179015371eb9bb7a48e3ef1185088e4/LICENSE), [HeliBoard license](https://github.com/HeliBorg/HeliBoard#license).

For a personal prototype, a signed APK attached to a tagged GitHub release is the shortest path. A public release also needs source at that tag, a clear cloud-data disclosure, and a routine for merging HeliBoard security and Android compatibility updates.
