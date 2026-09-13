# OpenRouter vocabulary hints test

Date: 2026-09-12. Model: `openai/gpt-transcribe`. No production code changed.

## Result

Provider-scoped `keywords` changed the target transcriptions in both repeats. The hint request used:

```json
{
  "provider": {
    "options": {
      "openai": {
        "keywords": ["Astra", "Raikage", "immortality", "OpenRouter"]
      }
    }
  }
}
```

All 12 requests returned HTTP 200. This proves OpenRouter accepted the request shape. OpenRouter did not return separate telemetry saying that it delivered the keywords to OpenAI. The repeated condition-specific corrections are strong evidence that the keywords affected these transcripts:

| Sample | Baseline, both repeats | Keywords, both repeats |
|---|---|---|
| 6 | `Astro` | `Astra` |
| 12 | `Roghage`; `in Mortality` | `Raikage`; `of immortality` |
| 9, negative control | "usage from the API key..." | identical |

The negative control did not acquire any glossary term. `OpenRouter` was already correct in sample 6 under both conditions, so this run says nothing about that word's individual effect.

## Method and cost

The public endpoint record returned provider tag `openai` and endpoint name `OpenAI | openai/gpt-transcribe-20260805`. OpenRouter documents provider-specific STT fields under `provider.options`, keyed by provider tag. Direct OpenAI documents `keywords` as a `string[]` for `gpt-transcribe` and `prompt` as free-form context. Sources: [OpenRouter STT provider options](https://openrouter.ai/docs/guides/overview/multimodal/stt#provider-specific-options), [OpenAI transcription parameters](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create#body-parameters).

The evaluator compressed each WAV once with production `AudioEncoding.Compress` and reused the same MP3 bytes for every condition and repeat. SHA-256 checkpoints confirm one MP3 payload per sample. It alternated baseline then keywords within each repeat, with two repeats per condition for samples 6, 12, and 9. The model, audio, and all other parameters stayed equal.

OpenRouter reported $0.010950 for the six baseline requests and $0.010950 for the six keyword requests, $0.021900 total. Keywords added no measured request cost.

Latency was inconclusive. Sample 12 took 1.41 seconds baseline and 3.97 seconds with keywords in repeat one, then 38.50 and 38.58 seconds in repeat two. Sample 6 was 0.63 to 0.76 seconds baseline and 0.53 to 0.58 seconds with keywords. Sample 9 was 6.36 to 6.43 seconds baseline and 6.40 to 6.45 seconds with keywords. Baseline always ran first within a repeat, and the large paired delay on sample 12 shows network or provider variance. This test cannot estimate a keyword latency penalty.

The planned prompt follow-up was skipped because the keyword condition already produced a replicated effect and the negative control stayed unchanged. The private [checkpoint artifact](../artifacts/hints-eval.json) contains every status, latency, cost, transcript, request option, and MP3 hash. It contains no API key or audio payload.
