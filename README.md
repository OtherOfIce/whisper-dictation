# Local Whisper

OpenRouter-powered dictation for Windows and Android. The desktop app uses an Electron interface with a hidden .NET audio engine. The Android app is a HeliBoard 4.1 keyboard with integrated GPT Transcribe voice input.

## Windows desktop

Run `dist/electron/LocalWhisper-win32-x64/LocalWhisper.exe`. Your existing OpenRouter key is reused automatically.

- Hold Ctrl + Win to speak. Release to finish and paste.
- Double-tap to lock recording; press again or click the checkmark to finish.
- The floating waveform has no text and only appears while recording or processing.
- History is searchable, survives restarts, and supports copying and deleting transcripts.
- Word counts show total, today, and the last seven local calendar days. Counts use saved history before cleanup, so deleting a transcript removes its words from these totals.
- Settings includes a Dictionary box. Paste preferred terms or phrases, one per line, and save. The full list is sent to GPT Transcribe as OpenRouter keyword hints, independently of Luna cleanup. Blank lines and case-insensitive duplicates are removed; clearing and saving disables hints. Terms are encrypted locally. The app caps lists at 1,000 terms, 120 characters per term, and 12,000 characters total; these are application limits, not verified provider limits. Large-list accuracy and latency remain untested.
- Settings offers Off, Luna, and Luna Fast text cleanup. Cleanup resolves spoken corrections and formatting instructions before paste. It defaults to Off and adds a separate timing stage. The performance drawer can show the original transcript when cleanup changed it.
- Hover over a transcript for its performance button. The graph excludes recording and clipboard cleanup by default; Include recording shows the full session.
- The account card shows balance and usage using the existing key. When only a key allowance is available, it is labelled separately from account balance. A separate balance key is optional.
- Closing the main window keeps dictation running. Open it from the tray icon; use the tray menu to quit.

Audio capture, 48 kbps MP3 compression, global shortcuts, cancellation, and pasting remain in the native engine. Electron owns all visible UI. Windows Forms is used internally only for the hidden Windows message pump and clipboard support; there are no WinForms screens.

Audio is never saved. Transcript history and timings are encrypted for your Windows account in `%APPDATA%/Local Whisper/history.bin`. Keys remain encrypted in `%LOCALAPPDATA%/LocalWhisper`. History begins with recordings made in this version; previous versions did not persist transcript text.

Settings includes optional transcription at pauses while speaking. It is off by default. It uploads chunks during recording and may affect punctuation or context. Cancelling cannot undo audio already uploaded. This uses file requests through OpenRouter, not a realtime WebSocket.

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
npm run package
```

Native tests: `dotnet run --project tests/LocalWhisper.Tests -c Release`.
The UI tests use demo fixtures and do not make API requests. The native `--credits` diagnostic checks the saved key without printing credentials or monetary amounts. The optional `--benchmark` diagnostic makes paid requests with generated speech.

The native engine communicates with Electron through private stdin/stdout pipes. Renderer windows are sandboxed with context isolation, restricted IPC commands, and no Node or network access. Keys are never returned to the renderer.

See `docs/performance-investigation.md` for measured upload improvements. The prior WinForms build is retained in `dist/LocalWhisper` as a fallback.

See `docs/transcribe-investigation.md` for the 12-file Wispr export benchmark, including actual API charges and per-file transcript comparisons. `docs/luna-wispr-investigation.md` compares Luna and Luna Fast on those same transcripts and records the compact prompt evaluation. `docs/luna-investigation.md` retains the earlier synthetic baseline.

## Android keyboard

The Android app lives in `android/`. It keeps HeliBoard's keyboard, dictionaries, layouts, gesture typing support, and customization while adding tap-to-start OpenRouter transcription from the microphone toolbar button.

- Add the OpenRouter API key under **Local Whisper Settings → Voice input**.
- Tap the microphone once to record and again to transcribe.
- Add preferred spellings and names to the personal transcription dictionary.
- Gesture typing uses HeliBoard's optional ABI-specific native library. See `android/GESTURE_TYPING_RESEARCH.md`.

Build the installable development APK with:

```powershell
.\tools\build-android.ps1
```

The output is `android/app/build/outputs/apk/debugNoMinify/LocalWhisperKeyboard_4.1-debugNoMinify.apk`. Android-specific implementation notes are in `android/ANDROID_NOTES.md`.
