# MAI simultaneous request benchmark, 23 September 2026

Run `dotnet run --project tests/LocalWhisper.Tests -c Release -- --mai-dual-benchmark --pairs 12`. The runner uses five seeded random recordings from the saved corpus, one each from 3–7, 7–12, 12–20, 20–30, and 30–50 second bands. For each pair, it compresses the same complete WAV once, releases two MAI-Transcribe-2 clean requests simultaneously through the same `HttpClient`, and waits for both. The app's internal timed hedge is disabled so each measured task makes one request unless a transient error triggers its normal retry. No request needed a retry in this run. Dictionary and Luna cleanup were excluded. The JSON report in `artifacts/mai-dual-benchmark.json` contains timings, costs, and a transcript equality flag, without transcript text.

An initial 4-pair-per-length run is preserved at `artifacts/mai-dual-benchmark-20pairs.json`. The larger independent run used 12 pairs per length, 60 pairs and 120 requests total.

| Audio length | Median gap between requests | Largest gap | Second request won |
| ---: | ---: | ---: | ---: |
| 3.1 s | 11 ms | 429 ms | 8/12 |
| 7.2 s | 39 ms | 843 ms | 8/12 |
| 19.0 s | 89 ms | 284 ms | 9/12 |
| 28.1 s | 11 ms | 219 ms | 5/12 |
| 33.0 s | 71 ms | 498 ms | 6/12 |

Across all 60 pairs, the median absolute gap was 30 ms, and 90% of gaps were at most 285 ms. The second request won 36 pairs. Racing both lowered the median from 511 ms for the first request to 412 ms for the faster request, while the median saving within a pair was just 4 ms. The mean saving was 65 ms. The second request saved over 100 ms in 13 pairs, over 250 ms in five, and over 500 ms in one. The largest example was 1,144 ms versus 301 ms on the 7.2-second recording. There were no request errors or retries. Exact transcript text matched in 57 of 60 pairs; all three disagreements occurred on the 7.2-second recording. Their semantic importance was not reviewed.

The 60 pairs cost $0.063333 in reported OpenRouter usage, consistent with charging both successful copies. The first 20 pairs cost about $0.021111. These are paired request timings, not Stop-to-paste latency. They do not measure whether running two simultaneous requests changes the latency distribution relative to a single request, nor whether an early client cancellation avoids billing after provider work starts. The shared OpenRouter route and provider may also give both copies correlated slowdowns. This small sample had occasional one-sided slow requests, but did not encounter a multi-second tail. It supports an early hedge experiment more than a blanket claim that immediate duplication will materially improve ordinary dictations.
