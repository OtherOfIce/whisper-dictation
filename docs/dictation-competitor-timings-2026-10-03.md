# Competitor dictation timings

Inspected on 2026-10-03. "Whisperflow" is interpreted as Wispr Flow. The local evidence below comes from this user's installed Windows applications, not vendor benchmarks. Both databases were opened through Python `sqlite3` with `mode=ro`. Queries returned schema, counts, dates, numeric aggregates and metadata key names. No transcript contents, audio, user identifiers or authentication settings were copied into this note.

## Wispr Flow

The local database is `%APPDATA%/Wispr Flow/flow.sqlite`. Its `History` table stores `e2eLatency`, `clientNetworkLatency`, `duration`, `speechDuration`, `status`, `timestamp`, and `appVersion`. These are readable without application decryption. The official uninstall documentation confirms that `flow.sqlite` holds local dictation history. [Wispr local data documentation](https://docs.wisprflow.ai/articles/3884018196-completely-removing-wispr-flow-from-your-device)

The installed `%LOCALAPPDATA%/WisprFlow/app-1.6.872/resources/app.asar` establishes the latency units. The history writer assigns `e2eLatency` from `basetenNetworkMetrics.endToEndTimeMsecs` and `clientNetworkLatency` from the difference between `totalNetworkOverheadMsecs` and `backendNetworkOverheadMsecs`. The application calculates end-to-end time from `recorderTimingInfo.absoluteStopTime` near the terminal transcription status. This supports interpreting the value as waiting after recording stops, rather than recording duration. The exact inclusion of every UI/paste step has not been independently timed.

| Metric, successful `status = 'formatted'` rows | Measured rows | Mean | Median |
| --- | ---: | ---: | ---: |
| End-to-end latency | 1,174 | 625.77 ms | 562.50 ms |
| Client network latency | 1,171 | 137.25 ms | 136.00 ms |
| Recording duration | 1,174 | 13.99 s | 11.18 s |
| Speech duration | 1,168 | 13.14 s | 10.36 s |

There are 1,303 total history rows. The successful sample runs from `2026-03-03 11:22:55.416 +00:00` to `2026-09-15 22:05:28.398 +00:00`; the most recent history row of any status is `2026-09-16 10:56:34.383 +00:00`. There are no Wispr rows since 2026-09-26. These historical numbers cannot establish a comparison for the user's past week. They also require matching recording lengths and timing boundaries against Local Whisper before calculating a speed advantage.

The app contains live runtime metrics such as fallback ASR/LLM times and component times. `History` does not preserve separate transcription and cleanup timing columns. The `logs` directory contains no files in this installation, so it supplies no additional historical per-stage measurements.

Wispr's engineering article gives a 700 ms post-speech expectation, with individual ASR and LLM budgets below 200 ms and a 200 ms networking budget. These are engineering targets, not this user's measurements and not a guaranteed current latency. [Wispr technical challenges](https://wisprflow.ai/post/technical-challenges)

## Typeless

The local database is `%APPDATA%/Typeless.exe/typeless.db`. It has an empty legacy `history` table and 786 rows in `history_v2`. Of the latter, 766 are `completed`, 15 `dismissed`, two `error`, and three have null status. There are 133 rows dated 2026-09-26 or later, with the newest dated 2026-10-01 UTC.

The schema exposes `duration`, `created_at`, `updated_at`, `audio_metadata`, `client_metadata` and `debug_info`. It has no plain end-to-end, ASR or cleanup latency columns. `created_at` and `updated_at` are history lifecycle timestamps; their difference is not a validated processing-time measurement. Sync and other updates can change that difference.

The outer `debug_info` JSON contains `audio_id`, `app_version`, and a nested `debug_info` string. All 766 nested strings are base64. A decoded sample begins with `Salted__`, consistent with an OpenSSL/CryptoJS-style salted encrypted payload. I did not attempt to decrypt it, and cannot say whether its contents include useful timing data.

`client_metadata` contains a `taking_longer_alert_delay_ms` setting and five `full_audio_compression_time_ms` measurements. Installed app code confirms that compression timing measures compression for retry/fallback handling. It is not total dictation latency or ASR/cleanup timing. `audio_metadata.audio_duration` is uniformly 3 in these rows, so that metadata field is not a reliable observed recording-duration measurement either. The separate `duration` column would need validation before use.

Typeless officially documents on-device history, audio export, retry, and configurable retention. Optional cloud sync was added to Windows in August 2026. Neither page documents an export of per-dictation processing latency. [Typeless history](https://www.typeless.com/help/quickstart/history-and-dictionary), [Windows cloud-sync release](https://www.typeless.com/help/release-notes/windows/keep-your-history-synced)

Typeless's privacy policy names performance metrics as usage data, but says server-side usage data is processed in real time and not retained except when voluntarily submitting feedback. That confirms the service can process diagnostics; it does not establish a historical local timing dataset. [Typeless privacy policy](https://www.typeless.com/privacy)

## What can be compared

Wispr has usable historical total wait metrics averaging about 0.63 seconds, with a median of about 0.56 seconds. Typeless's ordinary history fields do not provide a verified equivalent. No competitor database inspected here provides a directly readable transcription-versus-cleanup split.

Local Whisper's separately measured 123 successful `Pasted` sessions from 2026-09-26 11:38:30 BST to 2026-10-03 11:38:30 BST average 1,781.79 ms from recording stop to paste, with a 1,630.32 ms median. Mean audio duration is 16.32 seconds, with a 14.03-second median. The observed historical Wispr waits are lower, although its clips and dates differ. These records therefore do not support a claim that Local Whisper currently beats Wispr on post-recording wait. They also do not prove the relative result for identical clips today.

A fair future comparison should record the same audio through each product and measure from recording stop to delivered text. Report the recording duration, mean and median wait, and sample size. Keep that user-visible wait separate from full request timing when a product streams audio or processes it while the user is still speaking.
