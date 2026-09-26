# MAI pause chunk benchmark, 23 September 2026

Run `dotnet run --project tests/LocalWhisper.Tests -c Release -- --mai-pause-benchmark` to replay three saved 16 kHz mono recordings through the app's `PauseChunks` and `TranscriptionSession` paths. The pause condition feeds 40 ms frames on a real-time clock and uploads emitted chunks while playback continues. The single condition sends the whole recording at Stop. Each condition ran twice per recording, in single, pause, pause, single order. Both used MAI-Transcribe-2 clean through OpenRouter, without Luna cleanup. The report at `artifacts/mai-pause-benchmark.json` contains no audio or transcript text.

| Audio | Single Stop to result | Pause Stop to result | Chunks | Word errors against saved text, single / pause | Cost per run, single / pause |
| --- | --- | --- | ---: | --- | --- |
| 39.4 s | 1.365 s, 0.713 s | 4.067 s, 4.383 s | 7 | 4/79, 4/79 | $0.001111, $0.001222 |
| 28.1 s | 0.572 s, 0.476 s | 0.391 s, 0.293 s | 4 | 3/55, 4/55 | $0.000806, $0.000833 |
| 23.2 s | 0.470 s, 0.454 s | 0.435 s, 0.345 s | 3 | 5/40, 6/40 | $0.000667, $0.000694 |

Across six runs per condition, the median Stop to result was 0.524 s for one request and 0.413 s for pause chunks. That median hides the 39-second recording: both pause runs took over four seconds after Stop while both single requests finished within 1.4 seconds. The total reported request cost was $0.005167 for single and $0.005500 for pause, about 6.5% more. No hedges fired. The saved text is an edited Wispr transcript, not a verified verbatim reference, so the word error counts are a rough quality check. They also do not judge punctuation or whether cleanup preserved intent.

This is a small, same-day sample, not a latency percentile estimate. It measures the transcription path only, excluding microphone and UI handoff, Luna cleanup, paste, and any full-recording fallback. It does show that pause chunks can finish before or shortly after Stop, but a slow chunk can make the full result later than a single request. More ordinary dictations and repeated days would be needed before changing the default.

## Exact rerun

The same command was run again on 23 September with the same three recordings and request order. The first report was preserved as `artifacts/mai-pause-benchmark-first.json`; `artifacts/mai-pause-benchmark.json` contains the rerun.

| Audio | Single Stop to result, rerun | Pause Stop to result, rerun |
| --- | --- | --- |
| 39.4 s | 1.231 s, 0.692 s | 4.063 s, 4.023 s |
| 28.1 s | 0.614 s, 0.482 s | 0.289 s, 0.288 s |
| 23.2 s | 0.448 s, 0.770 s | 0.305 s, 0.350 s |

The rerun's median was 0.653 s for single and 0.327 s for pause chunks. The 39-second pause runs were again about four seconds, despite some variation elsewhere. Offline inspection of the pause boundaries shows a chunk emitted at about 39.24 seconds, only 0.12 seconds before Stop, followed by a 0.12-second tail. The current report does not identify which request occupied the four seconds, so the repeated delay could be tied to that boundary, the extra tiny request, queueing, or provider behavior. The two runs do not establish a general latency distribution, but they weaken the claim that the 39-second result was simply a one-off random slow request.
