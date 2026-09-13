# GPT Transcribe sample benchmark

Run on 2026-09-11 against the 12 WAV/TXT pairs in the user's local `WhiperFlow` export. Each audio file was sent once. No Luna requests were made during this benchmark.

## Result

All 12 requests succeeded. The set contains 150.392 seconds of audio. Production MP3 encoding reduced 4,813,072 WAV bytes to 916,692 bytes, or 19.0% of the original size. Median encoding time was 18 ms. The first encode took 101 ms because it includes Media Foundation startup; later short files usually encoded in 9 to 24 ms.

Median transcription request time was 732 ms and mean time was 846 ms. The range was 570 to 1,498 ms. Request time starts immediately before `Transcriber.TranscribeAsync` and ends after it parses the response, so it includes request serialization, upload, inference, response download, and JSON parsing. Encoding is measured separately.

Against the edited Wispr Flow text, 7 of 12 GPT Transcribe outputs matched after case and punctuation normalization. Micro-averaged word error rate was 5.71%, or 18 word edits over 315 reference words. The mean of the 12 per-sample rates was 5.81%.

These rates do not measure transcription accuracy against ground truth. Wispr Flow may remove false starts, revise wording, normalize names, and apply other edits after recognition. The comparison measures how close raw GPT Transcribe output is to the text Wispr Flow ultimately produced.

## Cost

OpenRouter returned `usage.cost` for every request. The actual total was **$0.011850**.

The continuous-duration estimate was $0.0112794, based on 150.392 seconds at the published $0.0045 per minute. The actual charge was 5.06% higher. OpenRouter reported 158 usage seconds across the requests, and $0.0045 × 158 / 60 equals $0.01185. The difference likely comes from per-request duration rounding and MP3 padding. The available documentation does not define the exact rounding rule, so the response cost remains the authority. The response did not include token counts, which is expected for this duration-priced model.

The actual response cost is stronger evidence than a key usage delta. No before-run key snapshot was taken, and a later balance read cannot reconstruct it. It would also include any concurrent use of the same key. The evaluator therefore records per-request `usage.cost` and duration estimates separately. If a future response omits costs, its aggregate reported cost remains unavailable rather than appearing as zero.

## Individual results

| Sample | Audio | Encode | Request | Normalized WER | S / D / I | Actual cost | Human review |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 8.3 s | 101 ms | 1,132 ms | 0.0% | 0 / 0 / 0 | $0.000675 | Match |
| 2 | 9.6 s | 18 ms | 739 ms | 0.0% | 0 / 0 / 0 | $0.000750 | Match |
| 3 | 11.6 s | 19 ms | 783 ms | 0.0% | 0 / 0 / 0 | $0.000900 | Match |
| 4 | 9.6 s | 16 ms | 724 ms | 12.5% | 2 / 0 / 1 | $0.000750 | Meaning preserved; GPT kept an opening discourse word and used small wording variants |
| 5 | 3.7 s | 9 ms | 612 ms | 0.0% | 0 / 0 / 0 | $0.000300 | Match |
| 6 | 7.0 s | 13 ms | 655 ms | 15.4% | 1 / 0 / 1 | $0.000600 | Material proper-name error: `Astra` became `Astro`; GPT also kept an opening discourse word |
| 7 | 12.6 s | 20 ms | 715 ms | 3.3% | 1 / 0 / 0 | $0.000975 | Meaning preserved; one phrasal wording difference |
| 8 | 8.2 s | 15 ms | 1,214 ms | 0.0% | 0 / 0 / 0 | $0.000675 | Match |
| 9 | 8.8 s | 21 ms | 570 ms | 0.0% | 0 / 0 / 0 | $0.000675 | Match |
| 10 | 9.9 s | 24 ms | 662 ms | 31.6% | 1 / 1 / 4 | $0.000825 | GPT included a plausible spoken false start that the edited reference omits and split `OpenRouter` into two words |
| 11 | 6.3 s | 13 ms | 854 ms | 0.0% | 0 / 0 / 0 | $0.000525 | Match |
| 12 | 54.9 s | 78 ms | 1,498 ms | 6.9% | 3 / 1 / 2 | $0.004200 | Material errors on `Raikage` and `immortality`, plus minor grammar edits |

`S / D / I` means substitutions, deletions, and insertions. Human review here compares the two texts. The benchmark did not conduct a second manual transcription from the audio.

Sample 12 is 16-bit, 16 kHz, mono PCM and lasts 54.896 seconds. The runner passed its raw WAV bytes through the same `AudioEncoding.Compress` method as production, which encoded it to MP3 at the production 48 kbps setting. It then called the same `Transcriber` class and model ID, `openai/gpt-transcribe`.

## Method

Normalization lowercases text, applies Unicode compatibility normalization, removes punctuation, and preserves apostrophes inside words. A word-level Levenshtein calculation reports substitutions, deletions, insertions, micro WER, and mean per-sample WER.

The evaluator captures the OpenRouter response body so it can retain `usage.seconds` and `usage.cost`, then restores the same body for the production `Transcriber` to parse. It writes full reference and hypothesis text only to the gitignored JSON artifact at `artifacts/transcribe-eval-gpt-transcribe.json`. Console output and this note contain aggregate metrics and short review notes, not the full sample text.

Run it with:

```powershell
dotnet run --project tools/transcribe-eval/TranscribeEval.csproj -c Release -- --source "C:\Users\Liam\Downloads\WhiperFlow" --output artifacts\transcribe-eval-gpt-transcribe.json
```

## Sources

- [OpenAI GPT Transcribe model and price](https://developers.openai.com/api/docs/models/gpt-transcribe)
- [OpenRouter GPT Transcribe model and price](https://openrouter.ai/openai/gpt-transcribe)
- [OpenRouter speech-to-text response usage schema](https://openrouter.ai/docs/guides/overview/multimodal/stt)
