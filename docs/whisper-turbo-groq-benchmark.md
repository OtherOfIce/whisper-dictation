# Whisper Large V3 Turbo (via Groq) latency benchmark

## Rerun on 2026-09-28: request-level Groq pin was ignored

The 30 reviewed clips were rerun with `--provider groq`, `--language en`, and
parallelism 2. All 30 requests succeeded. Micro-WER was **11.29%** (96 errors
across 850 reference words), with 13/30 exact clips. Median request latency was
1,517 ms, p90 was 2,819 ms, and reported cost was $0.001668.

OpenRouter's [transcription routing guide](https://openrouter.ai/blog/tutorials/transcription-on-openrouter/)
says `provider.order` and `allow_fallbacks` do not apply to this endpoint. A
single-clip probe with `--provider does-not-exist` still succeeded, confirming
the evaluator's provider hint was ignored. In the full run, 28 charges matched
DeepInfra's per-second price and two matched Groq's 10-second minimum charge.
The provider counts are inferred from billing. This run is **not** a Groq-only
benchmark. OpenRouter's [guardrails](https://openrouter.ai/docs/guides/features/guardrails/overview)
document a Groq-only provider allowlist for an API key. The docs describe it
as applying broadly, but do not confirm transcription specifically. It must
pass a one-clip provider check before treating it as an OpenRouter-billed pin.
The evaluator can now use a separate `OPENROUTER_BENCHMARK_KEY` and checks the
actual provider through OpenRouter generation metadata when passed
`--require-provider groq`. Verify a single clip before the full suite.

An additional live probe sent the full proposed routing object:
`{ "order": ["groq"], "only": ["groq"], "allow_fallbacks": false }`.
OpenRouter accepted the transcription request, but its generation metadata
reported **DeepInfra**. A negative control with `does-not-exist` in both
`order` and `only` also succeeded through DeepInfra. These are direct provider
checks, rather than inferences from cost. The failed verification reports are
`artifacts/transcribe-eval-exact-pin-groq-probe-20260928.json` and
`artifacts/transcribe-eval-exact-pin-negative-control-20260928.json`.

The new result is worse than the 2026-09-17 parallelism-2 run below (6.71%
micro-WER, 616 ms median). Different provider routing makes the two runs an
unreliable measure of model changes.

Private reports: `artifacts/transcribe-eval-normal-turbo-groq-attempt-20260928.json`
and `artifacts/transcribe-eval-turbo-invalid-provider-probe-20260928.json`.

```powershell
dotnet run --project tools/transcribe-eval/TranscribeEval.csproj -c Release -- --source artifacts/wispr-corpus/normal --model openai/whisper-large-v3-turbo --provider groq --language en --parallelism 2 --output artifacts/transcribe-eval-normal-turbo-groq-attempt-20260928.json
```

The candidate Groq-only command, after assigning a Groq-only guardrail to the
benchmark key and verifying one clip, is:

```powershell
dotnet run --project tools/transcribe-eval/TranscribeEval.csproj -c Release -- --source artifacts/wispr-corpus/normal --model openai/whisper-large-v3-turbo --language en --require-provider groq --parallelism 2 --output artifacts/transcribe-eval-normal-turbo-groq-guardrail.json
```

## Earlier run on 2026-09-17

Run on 2026-09-17 against the 30 reviewed clips in `artifacts/wispr-corpus/normal`
(438.688 seconds, 850 reference words). Model: `openai/whisper-large-v3-turbo`
with `language: "en"`, MP3 uploads, and the per-clip dictionary sent as both
`provider.options.openai.keywords` and `provider.options.groq.prompt`.

## Headline: fast when Groq serves it, slow routing the rest of the time

| Run | Median req | p90 req | Mean req | Micro-WER | Exact | Reported cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Turbo, parallelism 4 | 2,266 ms | 15,504 ms | 6,429 ms | 11.18% | 15 / 30 | $0.002900 |
| Turbo, parallelism 2 | 616 ms | 9,726 ms | 3,201 ms | 6.71% | 17 / 30 | $0.004542 |
| MAI clean baseline | ~530 ms | ~883 ms | — | 3.88% | 21 / 30 | $0.012694 |

MAI figures are the corrected-dictionary comparison in
`docs/muse-voice-transcribe-benchmark.md` and `docs/groq-latency-research.md`.
Turbo cost the least of any model tested so far (about half a cent for all
30 clips), but trailed MAI clean badly on accuracy: short-clip WER 9–12%
versus 2.91%, long-clip WER 6–11% versus 4.13%.

## Provider pinning does not work on the STT endpoint

Single-clip probes with `--provider groq`, `--provider deepinfra`, and
`--provider does-not-exist` all returned the identical Groq-billed usage
(`seconds: 10`, the 10-second minimum, `$0.000111`). `provider.order` and
`allow_fallbacks` are ignored for `/audio/transcriptions`; OpenRouter routes
freely between Groq and DeepInfra. The evaluator still sends the provider
hint, but it is routing advice at best.

Cost fingerprinting confirms the mix: requests billed at exactly
`max(audio, 10s) / 3600 * $0.04` were Groq-served and fast (388–1,908 ms);
requests billed far below that were fallback-served and slow (up to 30 s).
Same-clip transcripts differ between runs (e.g. one clip scored 14.3% then
0.0%), so the WER gap between the two runs above is routing noise, not a
parallelism effect.

## Accuracy: domain vocabulary is the gap

Turbo mangles the curated dictionary terms that MAI clean gets right:
`Myōboku` → `Mioboku`, `Hashirama` → `Hashiraba`,
`Raikage` → `Rykage` / `Road Cargate`, `shinobi` → `schnerber`, and dropped
`Jiraiya`. The Groq `prompt` hint did not fix this. Turbo also keeps spoken
fillers MAI clean removes.

## Verdict for latency-first dictation

- Best observed sync latency on OpenRouter for short dictation remains a
  Groq-served Whisper Turbo request (~400–700 ms), marginally beating MAI's
  ~530 ms median — but the app cannot pin routing, so p90 is multi-second.
- A Groq-only OpenRouter key guardrail is needed to test Turbo's strict Groq
  latency and accuracy. The request-level `--provider` flag cannot establish
  those figures.

Reports are gitignored (contain reference and model transcripts):

```text
artifacts/transcribe-eval-normal-turbo-groq.json
artifacts/transcribe-eval-normal-turbo-groq-strict.json
```

Rerun with:

```powershell
dotnet run --project tools/transcribe-eval/TranscribeEval.csproj -c Release -- --source artifacts/wispr-corpus/normal --model openai/whisper-large-v3-turbo --provider groq --language en --parallelism 2 --output artifacts/transcribe-eval-normal-turbo-groq-strict.json
```
