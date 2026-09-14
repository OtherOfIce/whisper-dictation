# MAI-Transcribe-2 investigation

Checked on 2026-09-13. This note records the public API/model facts and the
first local comparison with the existing `openai/gpt-transcribe` pipeline. No
application code is changed by this note.

## Recommendation

MAI-Transcribe-2 is worth a larger controlled trial. It is available through
the same OpenRouter speech-to-text endpoint used by this app, costs about 37%
as much as GPT Transcribe at current list prices, and its `clean` mode does
provide built-in filler/disfluency cleanup. The first 12-file run was not
large enough to claim an accuracy win, however: both models matched 7/12
edited Wispr references after normalization, and both had approximately 5.7%
micro-WER.

For the current OpenRouter client, the model slug is
`microsoft/mai-transcribe-2`. A model-only swap is sufficient for a basic
transcript request. The existing dictionary hint payload is not sufficient:
the app currently sends OpenAI-specific `provider.options.openai.keywords`,
whereas MAI's Azure provider expects `provider.options.azure.phraseList.phrases`.
Use `transcribeStyle: "verbatim"` for recognition-oriented tests and
`transcribeStyle: "clean"` for the product behavior under consideration.

## Public model and API facts

| Property | MAI-Transcribe-2 | GPT Transcribe |
| --- | --- | --- |
| OpenRouter model ID | `microsoft/mai-transcribe-2` | `openai/gpt-transcribe` |
| OpenRouter endpoint | `POST /api/v1/audio/transcriptions`, JSON base64 `input_audio` | Same |
| Direct provider endpoint | Azure Speech Fast Transcription REST API; multipart `audio` + JSON `definition` | OpenAI `POST /v1/audio/transcriptions`; multipart `file` |
| Current list price | $0.10/audio hour (limited-time offer through 2026-12-31) | $0.0045/audio minute = $0.27/audio hour |
| Languages | 60, automatic language identification; code switching supported | Language and multiple-language hints supported; the model page does not state a fixed language count |
| Punctuation/capitalization | Fast Transcription returns display form with punctuation/capitalization | The API returns text, but the model docs do not promise a separate cleanup mode |
| Filler/false-start control | `verbatim` keeps them; `clean` removes fillers and formats common spoken patterns | No documented built-in clean/verbatim switch |
| Word timestamps | Supported by `modelOptions.timestamps: "word"` | Supported with `response_format: "verbose_json"` and `timestamp_granularities: ["word"]` |
| Diarization | Supported, but preview requests around 15 minutes or longer can fail | GPT Transcribe itself is not the diarization model; OpenAI offers separate `gpt-4o-transcribe-diarize` |
| Keyword/context hints | Azure `phraseList.phrases`; hints, not forced output | `keywords` and free-form `prompt` are documented for `gpt-transcribe` |
| Custom prompting | Not supported by MAI in the Fast Transcription feature matrix | `prompt` is supported |

Microsoft's model page and model card describe MAI as a single multilingual
model with diarization, word timestamps, keyword biasing, noise robustness,
and clean/verbatim styles. Microsoft's Azure documentation gives the exact
request properties and confirms that `phraseList` terms are hints rather than
forced output. The Fast Transcription API returns display-form text, which is
the relevant punctuation/capitalization behavior for this app.

OpenRouter's MAI page documents the OpenAI-compatible request shape and the
Azure pass-through path. It specifically recommends
`provider.options.azure.diarization.enabled`,
`provider.options.azure.phraseList.phrases`, and
`provider.options.azure.enhancedMode.modelOptions.transcribeStyle`. OpenRouter
also reports a canonical dated slug (`microsoft/mai-transcribe-2-20260903`),
but requests should use the stable model ID above unless a pinned snapshot is
explicitly needed.

### Limits and availability caveat

The generic Azure Fast Transcription guide says an input should be under 5
hours and 500 MB. The versioned REST reference for the endpoint used by the
MAI docs says under 2 hours and 250 MB, while Microsoft's MAI model card says
2 hours and 300 MB. Treat 2 hours as the safe duration and 250 MB as the safe
size until the deployed region/API version is verified. Supported direct
input formats listed by Microsoft are WAV, MP3, and FLAC.

MAI is public preview, without an SLA. Azure direct access requires an Azure
subscription, Foundry Speech resource, key/region, and a supported region.
OpenRouter access is simpler for this repository. The model card's older
distribution text says OpenRouter was “coming soon”, but the current
OpenRouter model page and Microsoft's launch post document it as available;
the current pages should win over that stale card text.

## Published benchmark claims

Microsoft's launch post claims MAI is first on FLEURS across 60 languages with
5.2% average WER, second on the Artificial Analysis WER leaderboard, and up to
10x faster than leading competitors (including 10x faster than GPT Transcribe
in Artificial Analysis evaluations). The model card says the FLEURS score is
on the test split with inferred language and that one hour of audio takes about
10 seconds of model inference.

The model landing page presents a different FLEURS number: 3.4% averaged over
its “top 25 languages”, plus 2% on Artificial Analysis. These figures have
different scopes from the 5.2%/60-language claim and should not be treated as
one directly comparable score. They are vendor/leaderboard claims, not a
reproduction on this app's audio.

The relevant public benchmark sources are:

* [FLEURS dataset description from Google Research](https://research.google/pubs/fleurs-few-shot-learning-evaluation-of-universal-representations-of-speech/): 102 languages and about 12 hours per language; use its test split and WER for multilingual coverage.
* [LibriSpeech on OpenSLR](https://us.openslr.org/12/): about 1,000 hours of read English speech with `test-clean` and `test-other`; useful as a reproducible clean/noisy English baseline, but unlike spontaneous dictation.
* [Mozilla Common Voice datasets](https://commonvoice.mozilla.org/en/datasets): community speech with current language-specific and spontaneous-speech ASR datasets under CC0-1.0 listings; useful for accent and microphone diversity.
* [AMI Meeting Corpus](https://groups.inf.ed.ac.uk/ami/corpus/) and its [evaluation splits](https://groups.inf.ed.ac.uk/ami/corpus/datasets.shtml): 100 hours of meetings with orthographic transcription and multi-speaker annotations; use for diarization and meeting-style audio.

For this product, score normalized word-level Levenshtein WER (case and
punctuation-insensitive) for recognition, then score punctuation separately
(token-boundary precision/recall/F1), and score clean-mode disfluency removal
against a manually marked reference. Add human semantic-preservation ratings
because a cleaned transcript can have lower WER while dropping or rewriting
meaning. Record request latency, audio duration, success/timeout rate, and
provider-reported cost for every file. Do not use the Wispr-export text as
ground truth without a warning: Wispr may have already edited false starts,
names, wording, and punctuation.

## Local 12-file smoke comparison

The same 12 WAV files (150.392 seconds total) and edited Wispr text were sent
once to each condition through OpenRouter. Audio was compressed to MP3 using
the existing production encoder. The private reports are
[`transcribe-eval-gpt-transcribe.json`](../artifacts/transcribe-eval-gpt-transcribe.json),
[`transcribe-eval-mai-transcribe-2-verbatim.json`](../artifacts/transcribe-eval-mai-transcribe-2-verbatim.json),
and [`transcribe-eval-mai-transcribe-2-clean.json`](../artifacts/transcribe-eval-mai-transcribe-2-clean.json).

| Condition | Success | Normalized exact matches | Word errors / reference words | Micro-WER | Median request | Mean request | Reported cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| GPT Transcribe | 12/12 | 7/12 | 18 / 315 | 5.71% | 754 ms | 839 ms | $0.011850 |
| MAI verbatim | 12/12 | 7/12 | 18 / 315 | 5.71% | 324 ms | 1,675 ms | $0.004389 |
| MAI clean | 12/12 | 7/12 | 17 / 315 | 5.40% | 805 ms | 4,619 ms | $0.004389 |

The MAI charge is 37.0% of GPT's measured charge, or about 63.0% cheaper.
Both MAI reports were billed for 158 rounded usage seconds, matching
$0.10/hour. Clean and verbatim were separate one-shot runs; the large mean
latencies are dominated by the 54.9-second sample (about 35.5 seconds clean,
15.1 seconds verbatim). They are not evidence that clean mode intrinsically
takes that long. There was no alternating-order or repeated-trial design, so
latency is only a smoke signal.

MAI's recognition errors were different from GPT's even though their aggregate
verbatim WER tied. On the 54.9-second sample, MAI correctly produced `Raikage`
and `immortality`, both of which GPT missed. Both models heard `Astra` as
`Astro` on a short sample. A future run should repeat those names with and
without a short MAI Azure phrase list.

The clean setting removed hesitation markers and produced readable sentence
punctuation, but it was not a replacement for the existing Luna cleanup on
this set. In particular, it preserved the clearest spoken correction in
sample 10, which Luna removed in the earlier cleanup evaluation. It also used
fewer commas than verbatim in several otherwise word-identical clips. The
reference punctuation is Wispr's edited output rather than manual ground
truth, so this is a qualitative finding rather than a punctuation score.

MAI duplicated the final four words of the 54.9-second sample in clean and
verbatim mode. Two extra verbatim calls reproduced the same duplicate. Their
request times were 1.69 and 6.32 seconds, compared with 15.15 seconds in the
full run. This confirms substantial latency variation on OpenRouter and makes
the one-pass mean a poor estimate. GPT returned the long clip in 1.55 seconds
without the duplicate in the contemporaneous run.

The evaluator now accepts `--model`, optional MAI `--style`,
`--price-per-hour`, and `--sample` arguments. For example:

```powershell
dotnet run --project tools/transcribe-eval/TranscribeEval.csproj -c Release -- --model microsoft/mai-transcribe-2 --style clean --price-per-hour 0.10 --output artifacts/transcribe-eval-mai-transcribe-2-clean.json
```

## Sources

* [Microsoft AI: MAI-Transcribe-2 model page](https://microsoft.ai/models/mai-transcribe-2/)
* [Microsoft AI launch post (2026-09-03)](https://microsoft.ai/news/mai-transcribe-2-is-the-fastest-most-accurate-and-cheapest-speech-recognition-model-in-the-world/)
* [MAI-Transcribe-2 model card (PDF)](https://microsoft.ai/pdf/MAI-Transcribe-2-Model-Card.pdf)
* [Azure Speech MAI-Transcribe documentation](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-transcribe)
* [Azure Fast Transcription API guide](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/fast-transcription-create)
* [Azure Transcriptions REST reference, API 2025-10-15](https://learn.microsoft.com/en-us/rest/api/speechtotext/transcriptions/transcribe?view=rest-speechtotext-2025-10-15)
* [Azure Speech pricing](https://azure.microsoft.com/en-ca/pricing/details/speech/)
* [OpenRouter MAI-Transcribe-2 model page](https://openrouter.ai/microsoft/mai-transcribe-2)
* [OpenRouter speech-to-text guide](https://openrouter.ai/docs/guides/overview/multimodal/stt)
* [OpenAI GPT-Transcribe model page](https://developers.openai.com/api/docs/models/gpt-transcribe)
* [OpenAI create-transcription API reference](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)
* [OpenRouter GPT Transcribe model page](https://openrouter.ai/openai/gpt-transcribe)
