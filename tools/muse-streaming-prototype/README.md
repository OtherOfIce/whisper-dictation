# Muse streaming prototype

This console app tests Meta's direct Muse Voice Transcribe WebSocket without changing the production dictation path. It captures mono PCM16 at 16 kHz and sends 80 ms frames in `PUSH_TO_TALK` mode.

Run the safety preview first. It does not open the microphone or connect to Meta:

```powershell
dotnet run --project tools/muse-streaming-prototype -c Release
```

For a live test, set a Meta Model API key in the process environment and opt in explicitly:

```powershell
$env:MODEL_API_KEY = "your-key"
dotnet run --project tools/muse-streaming-prototype -c Release -- --live --seconds 30 --keyword Astra
```

The live path still waits for the exact confirmation `START`. Press Enter or Ctrl+C to stop early.

The prototype follows Meta's current API reference and sends `Bearer <key>` in the WebSocket handshake. Meta's official cookbook currently sends the raw key instead. If the first live test rejects an otherwise valid key, retry once with `--raw-token` and record which form the service accepts. Do not add automatic paid retries.

## Spend controls

- Each session stops after 60 seconds by default and can never exceed 300 seconds.
- A session must fit under the default $0.01 session limit and $0.05 UTC-day limit before the socket opens.
- The app reserves the full possible charge before connecting. It replaces the reservation with the greater of sent audio and Meta's acknowledged `audioProcessedMs` after a clean exit. A crash leaves the full reservation charged to the local ledger.
- The bounded microphone queue holds two 80 ms frames. If it fills, the app aborts instead of accumulating delayed audio.
- The microphone and WebSocket are disposed on normal completion, errors, timeout, Enter, and Ctrl+C.
- The prototype never saves the API key. It reads `MODEL_API_KEY` only after `--live` is present.

The ledger is `%LOCALAPPDATA%\LocalWhisper\muse-prototype-usage.json`. It is an estimate based on processed or sent audio and the published $0.18 per audio hour price checked on 2026-09-17. It rounds partial seconds up even though Meta documents rounding billed time down. It is not a Meta invoice. If the ledger is corrupt, locked, or unwritable, the paid stream does not start.

Override the local ceilings only when intentionally testing them:

```powershell
dotnet run --project tools/muse-streaming-prototype -c Release -- --live --seconds 120 --session-limit 0.01 --daily-limit 0.05
```

The production integration should store a separate Meta key with Windows data protection, expose these limits in Settings, and show estimated Muse usage beside provider-reported OpenRouter charges. Do not describe local estimates as settled billing.
