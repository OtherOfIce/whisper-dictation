# Whisper Large V3 Turbo (via Groq) latency benchmark

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
- If OpenRouter ever honors STT provider pinning (or with a direct Groq
  integration per `docs/groq-latency-research.md`), Turbo + strict Groq is
  the "how fast can we go" answer. Until then it is a latency gamble with a
  clear accuracy cost on domain terms.

Reports are gitignored (contain reference and model transcripts):

```text
artifacts/transcribe-eval-normal-turbo-groq.json
artifacts/transcribe-eval-normal-turbo-groq-strict.json
```

Rerun with:

```powershell
dotnet run --project tools/transcribe-eval/TranscribeEval.csproj -c Release -- --source artifacts/wispr-corpus/normal --model openai/whisper-large-v3-turbo --provider groq --language en --parallelism 2 --output artifacts/transcribe-eval-normal-turbo-groq-strict.json
```
