# Muse Voice Transcribe benchmark

Run on 2026-09-16 against the 30 reviewed clips in `artifacts/wispr-corpus/normal`.
The corpus contains 438.688 seconds of audio and 850 reference words. Each model
received each clip once in the final comparison.

## Initial historical-dictionary result

MAI Transcribe 2 clean remains the best choice for this corpus. Muse Voice
Transcribe 1.0 is credible, but it did not beat either MAI mode or GPT
Transcribe on word error rate.

| Model | Exact clips | S / D / I | Micro-WER | Macro-WER | Short-clip WER | Reported cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| MAI Transcribe 2 clean | 21 / 30 | 9 / 3 / 22 | 4.00% | 3.36% | 3.49% | $0.012694 |
| MAI Transcribe 2 verbatim | 19 / 30 | 11 / 3 / 31 | 5.29% | 4.32% | 4.65% | $0.012694 |
| GPT Transcribe | 14 / 30 | 20 / 3 / 27 | 5.88% | 5.56% | 8.14% | $0.034275 |
| Muse Voice Transcribe 1.0 | 12 / 30 | 24 / 8 / 28 | 7.06% | 7.68% | 10.47% | $0.021980 |

`S / D / I` means substitutions, deletions, and insertions. Short clips are ten
seconds or less. Muse also trailed on clips longer than ten seconds, at 6.19%
micro-WER versus 4.13% for MAI clean and 5.31% for GPT Transcribe.

Muse never beat MAI clean on a clip. It tied MAI clean on 14 clips and lost on
16. Against GPT Transcribe, Muse won 6 clips, tied 13, and lost 11.

## Dictionary handling

Muse accepts keyword biasing through Meta's `keywords` field. Through
OpenRouter, the evaluator now sends the saved dictionary as
`provider.options.meta.keywords`. The earlier exploratory run incorrectly sent
OpenAI's provider option, which Meta ignored.

Only three saved dictionary-term occurrences appeared in the reviewed
references. Muse retained all three, as did MAI clean and GPT Transcribe. Several
of Muse's material errors involved domain names that were absent from the
historical dictionary snapshots. Every snapshot also contained an unwanted
`2K` term.

## Curated-dictionary Muse rerun

The 30 normal-suite dictionary snapshots were corrected directly. `2K` was
removed, and `Hashirama`, `Raikage`, `Jiraiya`, `Myōboku`, `Onoki`, `shinobi`,
and `Kage` were added to every snapshot. No evaluator override was used.

| Muse dictionary | Exact clips | S / D / I | Micro-WER | Macro-WER | Short-clip WER | Reported cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Historical | 12 / 30 | 24 / 8 / 28 | 7.06% | 7.68% | 10.47% | $0.021980 |
| Curated | 15 / 30 | 15 / 7 / 28 | 5.88% | 5.51% | 5.23% | $0.021980 |

The corrected vocabulary fixed the `Hashirama` and `Raikage` clip completely,
fixed a second `Raikage` clip, preserved `Onoki` twice, and restored `shinobi`.
The `Myōboku` spelling was also fixed, although the surrounding `Jiraiya's`
phrase was still wrong.

Sending every domain term to every clip introduced one clear over-bias. Muse
changed `Astra medium` to `Hashirama`. The product should select dictionary terms
that are relevant to the current request instead of sending a large unrelated
list.

The other models were not rerun after the dictionary correction, so their
initial results should not be compared directly with the curated Muse result.

## Execution and latency caveat

Muse requires mono 16-bit PCM WAV at 16 or 24 kHz. The evaluator now preserves
the source WAV for Muse and continues using the production MP3 encoder for MAI
and GPT.

The evaluator also supports `--parallelism`, defaulting to four workers. The
corrected Muse run completed in about 3 minutes 14 seconds. Its median individual
request time was 3.2 seconds, but several long requests queued for much longer.
These OpenRouter synchronous timings do not predict Meta's direct streaming
performance. Meta's model uses streaming audio chunks and adaptive output delay,
so a direct streaming prototype needs its own latency test.

The final reports are gitignored because they contain the reference and model
transcripts:

```text
artifacts/transcribe-eval-normal-current-mai-clean.json
artifacts/transcribe-eval-normal-current-mai-verbatim.json
artifacts/transcribe-eval-normal-current-gpt-transcribe.json
artifacts/transcribe-eval-normal-current-muse-hinted.json
artifacts/transcribe-eval-normal-current-muse-curated-dictionary.json
```

Run Muse again with:

```powershell
dotnet run --project tools/transcribe-eval/TranscribeEval.csproj -c Release -- --source artifacts/wispr-corpus/normal --model meta/muse-voice-transcribe-1.0 --parallelism 4 --output artifacts/transcribe-eval-normal-current-muse-curated-dictionary.json
```

## Sources

- [Meta's Muse Voice Transcribe launch and streaming architecture](https://research.meta.ai/blog/introducing-muse-voice-transcribe)
- [OpenRouter Muse Voice Transcribe model page](https://openrouter.ai/meta/muse-voice-transcribe-1.0)
- [OpenRouter speech-to-text provider options](https://openrouter.ai/docs/guides/overview/multimodal/stt)
