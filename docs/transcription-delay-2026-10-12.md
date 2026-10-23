# Transcription delay on 12 October 2026

The recording that started at 21:51:11 Europe/London lasted 3.568 seconds and took 35.797 seconds after Stop to paste. The session ID is `d382862fb1154c3ca55d618c6eda8124`.

The timings were decrypted from a read-only query of the desktop history database. Only metrics were read, without transcript text or audio. The local capture is `artifacts/slow-transcription-metrics.json`.

## What happened

MAI streaming connected through Vercel AI Gateway, then failed while recording. The saved error was `Transcription provider stream error`. The provider did not give a more specific cause, so this capture cannot establish why its stream failed.

The engine started recorded-audio recovery immediately after stopping the microphone. Recovery took the MAI Clean route through `TranscriptionPipeline.Recorded`. That route omitted the saved MAI race setting, which was enabled. It therefore used a single MAI request with a second MAI hedge, rather than the normal race with a delayed GPT fallback.

The first MAI request took 34.991 seconds. A second MAI request started about 2.7 seconds later and took 32.407 seconds. Both were slow, so duplicating the same provider did not recover promptly. GPT was never started because MAI eventually succeeded before its timeout. Audio preparation took about 37 ms, Luna Fast cleanup took 733 ms, and paste took about 37 ms. UI gaps peaked at 47 ms. This was a provider wait amplified by the recovery policy, with no evidence of a UI freeze.

A second streaming provider error occurred at 22:55:18. Its 62.058-second recording reached cleanup after 9.637 seconds of recovery. The MAI hedge won while the first request continued for measurement. This shows that the streaming error recurred, though the recovery delays varied.

## Changes

Automatic recovery now forwards the saved MAI race setting. With the race enabled, GPT starts after the existing recording-length-dependent delay if MAI has not succeeded. The delay is approximately 2.7 seconds for the affected recording and is capped at ten seconds. Turning the MAI race off still disables this recovery race. Exact model comparisons retain their existing behavior.

One failed MAI request no longer disables the GPT timer for its stalled sibling. If both MAI requests fail before that timer, GPT starts immediately. The recovery result and History retain GPT as the successful model when it wins, rather than overwriting it with the MAI step's name.

Live dictation now has one 15-second transcription budget after microphone shutdown. It covers finishing the current session, provider retries, and automatic recovery. On expiry the app retains the audio in History, makes it available for retry, and reports a timeout. Escape remains an explicit cancellation that discards the session. Once a transcript is obtained, this budget is disabled. AI cleanup retains its separate 15-second limit and raw-text fallback. This is a transcription limit, not a guarantee that all dictation including cleanup finishes in 15 seconds.

The provider's streaming fault can recur. These changes address the app's response to that fault and the prolonged wait it caused.

## Validation

Before the fix, `dotnet run --project tests/LocalWhisper.Tests -c Release -- --recovery-latency` failed with `TaskCanceledException` after five seconds. Its HTTP fixture stalls MAI while keeping GPT responsive and exercises the actual recorded recovery path after a streaming failure.

After the fix, the same recovery test reaches GPT within five seconds and verifies the selected model. Additional checks cover one failed MAI request with a stalled sibling, both MAI requests failing, and cancellation of recovery without starting further providers. All fixtures use fake transport and make no paid requests.

The full native suite passed 262 checks. The desktop suite passed 20 tests. A self-contained Windows engine was published to `dist/latency-fix-engine` and passed the engine IPC smoke test. The running app has not been restarted or replaced, so it still needs the updated engine before these changes affect live dictation.
