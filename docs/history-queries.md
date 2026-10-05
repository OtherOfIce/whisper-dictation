# Querying local dictation history

Run from the repository root on Windows, under the Windows account that recorded the dictations:

```powershell
node tools/history-timings.cjs --days 7
node tools/history-timings.cjs --from 2026-09-26T10:38:30Z --to 2026-10-03T10:38:30Z
```

Install the desktop dependencies with `npm ci --prefix desktop` if Electron is missing. The command launches Electron in the background and prints aggregate JSON. It makes no API requests. It opens the history database read-only and decrypts only metrics, without reading transcript text or audio. Electron initializes its usual profile services while running; the SQLite connection is read-only.

## Storage and encryption

The desktop database is `%APPDATA%\Local Whisper\history.sqlite`. `%LOCALAPPDATA%\LocalWhisper` contains engine settings and credentials, not desktop history. `--user-data` overrides the desktop profile directory.

The schema is in [history-store.cjs](../desktop/history-store.cjs). `History.createdAt` is the session start time, stored as an ISO date with timezone offset. `metrics`, `text`, `rawText` and `alternatives` are encrypted blobs. Current recordings are stored as WAV bytes in `audio`. Do not use `HistoryStore.read()` for a timing query: it decrypts transcript text and its initialization can create or migrate tables. Use a read-only SQLite connection and select only the columns needed.

Electron `safeStorage` decrypts the metrics. On this installation the blobs have a `v10` prefix. The correct Windows account alone is insufficient: Electron must use the original app profile and its `Local State` encryption key. The command sets `app.setPath('userData', ...)` before `app.whenReady()`. Launching Electron with a fresh profile fails to decrypt these records. No API key is needed. Keep the profile's encryption material private.

For another question, reuse that startup and read-only query pattern. Decrypt only the required columns. Prefer aggregate answers and avoid writing plaintext transcript exports unless requested.

## Timing definitions

The snapshot format is in [Metrics.cs](../src/LocalWhisper/Metrics.cs), and the stage boundaries are in [EngineApp.cs](../src/LocalWhisper/EngineApp.cs). Times are milliseconds relative to a monotonic session clock. `started` is a wall-clock timestamp. Date filters use SQLite `julianday`, so different timezone offsets compare correctly. The interval includes `--from` and excludes `--to`. The default is the trailing 168 hours, not seven calendar dates.

Only `Pasted` outcomes with valid stop and paste timestamps enter the summary. Saved, failed, combined transcription-and-cleanup, and malformed sessions appear in `excluded`. The summary groups records by transcription model and cleanup mode. A cleanup span proves cleanup was attempted, but the schema does not distinguish a successful cleanup from an attempt that failed and fell back to raw text.

- `totalMs` is `pasteMs - stopMs`, the wait after releasing the dictation key.
- `transcriptionMs` is the interval from Stop to the start of AI cleanup. It includes microphone shutdown, compression, upload, provider time, retries and fallback. Without cleanup, it ends at the start of the paste stage. This measures how long the user waits for a usable transcript, not just provider compute time.
- `cleanupMs` is the AI cleanup span clipped to stop-to-paste.
- `otherMs` is the remaining stop-to-paste time, principally paste work and waits between stages.
- Speaking time and clipboard restoration after paste are excluded.

Do not sum `Transcribe audio` rows. MAI race requests overlap, and the losing request can continue after cleanup begins or after paste. Streaming and pause chunks can run while the user speaks. Elapsed stage boundaries avoid double counting that background work.

`transcriptionPct`, `cleanupPct` and `otherPct` divide each session's duration by that session's stop-to-paste duration. Their means and medians summarize those per-session shares. Independently calculated medians need not sum to 100%. `transcriptionOfTwoStagesPct` and `cleanupOfTwoStagesPct` omit paste overhead and sum to 100% per session. `weightedShares` divides summed stage durations by summed stop-to-paste durations; it gives long sessions more weight. Mean and median absolute times are calculated independently of percentage summaries.

## Measured week ending 3 October 2026

Window: 26 September 11:38:30 to 3 October 11:38:30, Europe/London. The query found 136 records, of which 123 pasted successfully, 5 saved to history and 8 failed. All 123 successful sessions used MAI Clean and Luna Fast.

| Measure | Mean time | Median time | Mean share of stop-to-paste | Median share |
| --- | ---: | ---: | ---: | ---: |
| Transcription, including preparation | 0.768 s | 0.685 s | 41.13% | 40.74% |
| AI cleanup | 0.970 s | 0.888 s | 56.24% | 55.81% |
| Other, principally paste | 0.044 s | 0.040 s | 2.63% | 2.48% |
| Stop-to-paste total | 1.782 s | 1.630 s | 100% | 100% |

Considering just transcription and cleanup, mean shares were 42.23% and 57.77%; median shares were 42.09% and 57.91%. Across all elapsed milliseconds, the stop-to-paste shares were 43.13%, 54.41% and 2.46%. The mean recording was 16.32 seconds, median 14.03 seconds. Failed requests are excluded from these successful-dictation latency statistics.

The aggregate JSON is saved locally in `artifacts/history-timings-week-2026-10-03.json`. Artifacts are ignored by Git. Validation used an isolated encrypted fixture with cleanup on and off, a failed session, a combined stage, an overlapping losing request and a paste span extending beyond paste. The fixture confirmed the expected durations and exclusions without changing the user's database.

For future one-off questions, this command and the definitions above remove the repeated storage and encryption investigation. A general metrics export command or a read-only local query API would be the next useful addition if questions extend beyond timing summaries. Neither needs to weaken the existing encryption.
