# Local Whisper

OpenRouter-powered dictation for Windows and Android. The desktop app uses an Electron interface with a hidden .NET audio engine. The Android app is a HeliBoard 4.1 keyboard with integrated GPT Transcribe voice input.

## Windows desktop

Install the [latest Windows release](https://github.com/OtherOfIce/whisper-dictation/releases/latest/download/LocalWhisper-Setup.exe). Your existing OpenRouter key is reused automatically. Installed copies check for updates after launch and every six hours. A downloaded update installs when you quit Local Whisper from the tray, after history has been saved.

The first installer must be run manually if you currently use the unpacked `dist/electron/LocalWhisper-win32-x64/LocalWhisper.exe`. It keeps the same app name and user data location, so your settings and history remain available. Development runs and unpacked builds do not check for updates.

- Settings lets you rebind the dictation shortcut. Click Change shortcut, press and release a combination, then save. Use two or more modifiers, or a modifier with a letter, number, function key, or Space. Reset restores Ctrl + Win. Conventional combinations are checked for Windows reservations and registered conflicts; modifier-only combinations and shortcuts handled by other low-level hooks cannot be checked reliably.
- Press Ctrl + Win to speak. Recordings start in lock mode by default, so press the shortcut again to finish.
- Turn off Default to lock mode in Settings to use push-to-talk mode. Hold Ctrl + Win to speak and release to insert. Double-tap the shortcut to switch that recording to lock mode. Escape discards a recording.
- A compact waveform appears while the app is recording or transcribing.
- Settings includes a microphone selector. System default keeps Windows in control; a specific input is remembered across restarts. Refresh microphones after connecting a device. A disconnected selected microphone must be reconnected or changed before recording.
- Test microphone in Settings records up to five seconds from the currently selected input, including an unsaved selection. Watch the live input meter, stop early if needed, and click Play test to hear it. Test audio stays in memory, is never transcribed or saved to History, and is discarded when you leave Settings, switch microphones, or the window loses focus.
- History is searchable, survives restarts, and supports copying and deleting transcripts.
- Word counts show total, today, and the last seven local calendar days. Counts use saved history before cleanup, so deleting a transcript removes its words from these totals.
- Settings lets you choose GPT-Transcribe, MAI-Transcribe-2 Verbatim, MAI-Transcribe-2 Clean, or the experimental Grok Voice Transcribe 2.0 streaming mode. MAI Clean remains the default.
- The MAI race is on by default and can be changed in Settings. It sends two requests at once and uses the first successful transcript. If both are slow, GPT-Transcribe starts after a recording-length-dependent delay. The other requests continue for timing and cost measurement. Pause chunking remains optional and off by default.
- Grok streaming connects directly to xAI when recording starts, sends mono 16 kHz PCM in 100 ms WebSocket frames while you speak, and finalizes the transcript when recording stops. Add an xAI key in Settings; it is encrypted for the current Windows account. Luna cleanup still uses the separately saved OpenRouter key.
- Settings includes a Dictionary box. Paste preferred terms or phrases, one per line, and save. The full list is sent as recognition hints using the selected provider's request format, independently of Luna cleanup. Blank lines and case-insensitive duplicates are removed; clearing and saving disables hints. Terms are encrypted locally. Grok accepts at most 100 keyterms of 50 characters each; the app rejects an incompatible Grok selection rather than silently dropping terms. Other models retain the app limits of 1,000 terms, 120 characters per term, and 12,000 characters total.
- The Dictionary section can import active terms from a local Wispr Flow installation. It merges them with the terms already in the editor, uses the final text of replacement entries, skips snippets, and saves the merged dictionary immediately.
- Dictionary sync can share saved preferred terms with the Android keyboard through Convex. Enter the same deployment URL and shared sync key on both devices. See [setup and sync behavior](docs/dictionary-sync.md).
- Learn from corrections is on by default. In a supported editable text field, correcting one or two dictated words adds the new spellings to the Dictionary once the edit settles. A popup shows each saved word and offers Undo. Brief app switches pause observation so you can check a spelling and return. You can turn learning off in Settings or remove a term from the Dictionary box. Password fields, larger rewrites, and fields that cannot be read reliably are skipped.
- Settings offers Off, Luna 6, and Luna 6 Fast text cleanup. Cleanup resolves spoken corrections and formatting instructions before paste. When enabled, the app reads up to 500 characters before, within, and after the current selection so Luna can fit capitalization, punctuation, and formatting to the insertion point. Password fields are excluded, unsupported fields fail open without context, and the captured text is sent only with the cleanup request. Cleanup defaults to Off and adds a separate timing stage. The performance drawer can show the original transcript when cleanup changed it.
- Hover over a transcript for its performance button. The graph excludes recording and clipboard cleanup by default; Include recording shows the full session.
- If the selected voice model still fails after its own retries, the app transcribes the complete recording with the next configured provider. History records both the requested and successful models.
- Saved recordings can be transcribed again with another model from History. Alternate versions are stored beside the primary transcript for comparison, copying, or promotion to the primary version.
- The account card shows balance and usage using the existing key. When only a key allowance is available, it is labelled separately from account balance. A separate balance key is optional.
- Closing the main window keeps dictation running. Open it from the tray icon; use the tray menu to quit.

Audio capture, 48 kbps MP3 compression, global shortcuts, cancellation, and pasting remain in the native engine. Electron owns all visible UI. Windows Forms is used internally only for the hidden Windows message pump and clipboard support; there are no WinForms screens.

Transcript text, alternate versions, and timings are encrypted for your Windows account. Original recordings are stored in the local history database so failed requests can be recovered and model results can be compared. Keys remain encrypted in `%LOCALAPPDATA%/LocalWhisper`.

Settings includes optional transcription at pauses while speaking for the OpenRouter models. It is off by default. It uploads file chunks during recording and may affect punctuation or context. Grok's streaming mode instead sends the microphone feed continuously over a direct xAI WebSocket. Cancelling cannot undo audio already uploaded in either mode.

## Development

Requires Windows, .NET 10 SDK, and Node.js.

```powershell
dotnet publish src/LocalWhisper -c Release -r win-x64 --self-contained true -o dist/engine
cd desktop
npm ci
npm start
npm test
npm run test:ui
npm run test:engine
# Optional: captures the system-default microphone locally, without API requests
npm run test:microphone
npm run package
npm run package:installer
```

Every push to `main` runs the Windows release workflow. After tests pass, it builds the .NET engine and NSIS installer, assigns version `0.4.<workflow run number>`, and publishes a GitHub Release with update metadata and generated change notes. Version numbers do not need manual edits. The installer is in `dist/installer/` when built locally; local builds do not publish releases.

Windows builds are currently unsigned, so Windows may warn before the first installation. A code signing certificate can remove that friction later.

To stop old project builds, rebuild everything, and launch the packaged Windows app in one step, run `.	oolsuild-windows.ps1` from the repository root.

Native tests: `dotnet run --project tests/LocalWhisper.Tests -c Release`.
The UI tests use demo fixtures and do not make API requests. The native `--credits` diagnostic checks the saved key without printing credentials or monetary amounts. The optional `--benchmark` diagnostic makes paid requests with generated speech.

The native engine communicates with Electron through private stdin/stdout pipes. Renderer windows are sandboxed with context isolation, restricted IPC commands, and no Node or network access. Keys are never returned to the renderer.

See `docs/performance-investigation.md` for measured upload improvements. The prior WinForms build is retained in `dist/LocalWhisper` as a fallback.

See `docs/transcribe-investigation.md` for the 12-file Wispr export benchmark, including actual API charges and per-file transcript comparisons. `docs/luna-wispr-investigation.md` compares Luna and Luna Fast on those same transcripts and records the compact prompt evaluation. `docs/luna-investigation.md` retains the earlier synthetic baseline.

The private Wispr corpus exporter writes one `.dictionary.json` snapshot beside each recording. It reconstructs the terms available at recording time from Wispr's dictionary creation timestamps. The transcription evaluator loads that sample-specific snapshot automatically. Wispr's exported transcript is only a provisional reference and must be checked against the recording before treating its WER as a quality result.

## Android keyboard

The Android app lives in `android/`. It keeps HeliBoard's keyboard, dictionaries, layouts, gesture typing support, and customization while adding tap-to-start OpenRouter transcription from the microphone toolbar button.

- Add the OpenRouter API key under **Local Whisper Settings → Voice input**.
- Tap the microphone once to record and again to transcribe.
- Add preferred spellings and names to the personal transcription dictionary.
- MAI requests race by default; both may be billed. Voice input settings can turn the race off and enable optional Luna cleanup.
- If transcription fails, the keyboard keeps one recording locally. Tap the microphone to retry it in a text field, or discard it in Voice input settings.
- Voice input → Recording diagnostics can temporarily keep ten recordings with playback, raw transcripts, and audio measurements. It saves audio locally and supports ZIP export or [retrieval over ADB](docs/android-recording-diagnostics.md).
- Gesture typing uses HeliBoard's optional ABI-specific native library. See `android/GESTURE_TYPING_RESEARCH.md`.

Build the installable development APK with:

```powershell
.\tools\build-android.ps1
```

The output is `android/app/build/outputs/apk/debugNoMinify/LocalWhisperKeyboard_4.1-debugNoMinify.apk`. Android-specific implementation notes are in `android/ANDROID_NOTES.md`.
