# Local speech recognition on Liam's dictation benchmark

Closed on 2026-10-03 at the user's request. Cloud transcription remains the chosen direction. Cleanup of the downloaded models, experiment runtimes, benchmark scripts, copied recordings, raw results and model manifest was requested, but automatic approval review blocked deletion. Those files remain pending cleanup. Measurements below are historical findings from the completed experiment.

Measured on 2026-10-03. This is a benchmark experiment, with no app integration or local cleanup. The recordings are English; English-only models are welcome, but multilingual models were tested too. Quality and correction effort matter more here than an offline guarantee.

## What was measured

The private benchmark has 30 reviewed recordings, 438.688 seconds of audio and 850 scoring words. Every recording uses its own saved dictionary, with 29 to 34 phrases. There are 34 unique phrases across the set. Inputs came from the primary checkout's existing artifacts and were copied into this worktree's ignored artifact directory. No ongoing shortcut or microphone work was changed.

Hardware is an AMD Ryzen 7 3700X with 8 cores and 16 threads, approximately 24 GiB of RAM, and an NVIDIA RTX 3080 with 10 GiB VRAM, driver 591.86. This machine supports CUDA. GPU results do not predict performance on a CPU-only laptop or Android phone.

Each recognizer loads once, receives one unscored warmup, then processes all recordings with dictionary ON and OFF. GPU recognizers use two repetitions per condition. Moonshine's initial CPU runs use one. Accuracy counts each recording once; latency pools the repetitions. Audio decoding, model download and model load are outside the per-recording timer. Native inference completes synchronously and Python generators are consumed completely before timing stops.

WER is total substitutions, deletions and insertions divided by 850 reference words. Lower is better. Exact matches use the same normalized word policy, rather than punctuation-perfect text. The scorer applies the existing corpus equivalence policy for diacritics, spelling variants, numbers and accepted phrases. It reproduces the app evaluator's alignment tie-break. Every score component and reference was cross-checked against four saved cloud reports, with no mismatches.

All local outputs are raw recognition. There is no LLM cleanup, dictionary replacement after recognition, editor context, transcript-specific prompt, or filtering based on the expected answer. The main pass disables VAD; a separate Turbo configuration tests it. Reviewed references represent intended dictation, so raw recognizers can lose points for retained fillers and false starts. The historical MAI verbatim result is included to make that distinction visible.

The cloud baselines are historical context, not fresh paired API experiments. Their recording IDs and reviewed references match, but their saved dictionary counts differ from today's sidecars. September 16 runs used 24 to 30 terms and the September 17 curated run used 30 to 35, versus 29 to 34 here. The reports retain counts, not the exact hint content. Cloud uploads also used the evaluator's encoded audio rather than these local float PCM arrays. Consequently a close WER difference should not be presented as a controlled local-versus-cloud win.

## Results

| Model | Device | WER dictionary ON | WER OFF | Errors ON | Exact ON / 30 | Median ON | p90 ON |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Whisper Large v3 | GPU | 5.18% | 5.06% | 44 | 18 | 709 ms | 1561 ms |
| Qwen3-ASR 1.7B | GPU | 5.88% | 6.59% | 50 | 17 | 1734 ms | 4020 ms |
| Qwen3-ASR 0.6B | GPU | 6.59% | 7.76% | 56 | 17 | 1871 ms | 4152 ms |
| Whisper Small.en | GPU | 6.82% | 8.59% | 58 | 13 | 286 ms | 912 ms |
| Whisper Turbo + VAD | GPU | 7.18% | 6.12% | 61 | 18 | 267 ms | 468 ms |
| Nemotron English 0.6B Q8 | GPU | 7.76% | 7.88% | 66 | 16 | 54 ms | 194 ms |
| Distil-Whisper Large v3 | GPU | 9.06% | 8.82% | 77 | 12 | 223 ms | 346 ms |
| Moonshine Medium streaming | CPU | 15.29% | 14.71% | 130 | 8 | 2556 ms | 7116 ms |
| Moonshine Small streaming | CPU | 18.59% | 17.18% | 158 | 4 | 1861 ms | 4723 ms |
| Whisper Turbo, no VAD | GPU | 18.71% | 6.12% | 159 | 18 | 252 ms | 435 ms |

All final jobs succeeded on all 30 recordings per condition. Every GPU condition produced identical per-recording scores across both repetitions.

Saved cloud comparisons, with their original request timings:

| Saved cloud run | Date | WER | Errors | Median request | p90 request |
| --- | --- | ---: | ---: | ---: | ---: |
| MAI Clean, saved dictionary | 2026-09-16 | 4.00% | 34 | 530 ms | 883 ms |
| MAI Verbatim, saved dictionary | 2026-09-16 | 5.29% | 45 | 501 ms | 836 ms |
| MAI Clean, curated dictionary | 2026-09-17 | 3.88% | 33 | 606 ms | 933 ms |
| GPT Transcribe, saved dictionary | 2026-09-16 | 5.88% | 50 | 725 ms | 1198 ms |

Cloud request timing includes upload/network/service time and excludes its separate audio encode phase. Local timing measures in-memory recognition. These columns are useful operational context, but are not an identical end-to-end timing measurement.

Median and p90 are warm full-recording recognition times, not time to the first streaming word. A model can process a long recording in less than its audio duration. These times exclude recording, IPC, insertion and cleanup. Moonshine uses its complete-recording API with streaming architecture weights; this experiment does not measure the latency benefit of doing work while the user speaks.

## Dictionary verification

The dictionary is an inference input. A visible setting or a nonempty JSON file alone was not treated as proof.

| Recognizer | Actual hint mechanism | Verification |
| --- | --- | --- |
| Whisper | faster-whisper `hotwords`, supplied to every decode window | Per-recording term count and prompt token count recorded; all prompts fit its 223-token budget. Dictionary OFF supplies no hints. |
| Qwen | Official `context` parameter, a system message containing the relevant vocabulary | The adapter asserts the actual processor system message equals the requested context. English is explicitly selected. |
| Moonshine | Native `set_keyterms`, boost 2.0 | Per-recording keyterms set or cleared before every call. Streaming model architectures were selected because legacy Tiny/Base do not support this feature. |
| Nemotron | Native C ABI `speech_contexts`, boost 2.0 | Embedded tokenizer, phrase tokenization and model SHA checked before loading. Unsupported hints are recorded explicitly. |

These are different mechanisms, not interchangeable strengths of the same algorithm. Dictionary hints can improve rare words or cause false insertions. The control runs measure that tradeoff. [Whisper implementation](https://github.com/SYSTRAN/faster-whisper/blob/master/faster_whisper/transcribe.py), [Qwen context construction](https://github.com/QwenLM/Qwen3-ASR/blob/main/qwen_asr/inference/qwen3_asr.py), [Moonshine domain customization](https://github.com/moonshine-ai/moonshine/blob/main/docs/models/domain-customization.md), [NVIDIA customization](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/47f43763bb40ec463150dd8d9a788c54f3728bdb/docs/asr/customization.md).

Dictionary ON changed 24 of 30 Small.en outputs, 19 Large v3 outputs, 23 Distil outputs, and 27 Turbo outputs. It changed 14 Qwen 0.6B outputs, 18 Qwen 1.7B outputs, 15 Moonshine Small outputs, 16 Moonshine Medium outputs, and 12 corrected Nemotron outputs. These controls support the API audits. They do not imply every supplied phrase is guaranteed to appear correctly.

### Nemotron's initially broken dictionary

The publisher's downloaded Q8 GGUF loaded and transcribed, but the runtime warned that it could not tokenize phrases because the embedded SentencePiece tokenizer was missing. That silently disabled boosting. Its identical ON/OFF outputs were rejected as an invalid dictionary benchmark.

The benchmark preparation script extracts the tokenizer from the matching pinned official `.nemo` archive and adds `asr.tokenizer.spm_model` to a derived GGUF. All 653 tensors and every original metadata field were verified unchanged. This follows the upstream converter's tokenizer format. The tested file is a repaired derivative, rather than the untouched publisher artifact. [Official conversion code](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/47f43763bb40ec463150dd8d9a788c54f3728bdb/conversion/asr.py).

Of the 34 distinct dictionary phrases, 32 tokenize unchanged. `Myōboku` uses the explicit accent-free hint `Myoboku`. One email phrase cannot be fully tokenized because `@` is unsupported and is explicitly omitted from Nemotron's hints. The reference and scoring stay unchanged. This is a real dictionary limitation, and should block claiming full dictionary parity in an app. The corrected run produced no boosting-disabled warning and changed outputs between ON and OFF.

Original GGUF SHA-256 is `d9a01898d2a611c8764e23a1c2f45e70bbd5a425dc4de93692ac951dd603812d`; tested derived SHA-256 is `926495522ccd2626d8665283b4c9225f704ed2b45e82158984d1823f7e528b52`. Tokenizer SHA-256 is `07d4e5a63840a53ab2d4d106d2874768143fb3fbdd47938b3910d2da05bfb0a9`. Detailed provenance and phrase audits stay with the private artifacts.

### Whisper's initial dictionary experiment

Initial runs used `initial_prompt` with the entire saved dictionary. Small English scored 7.06% WER, Distil Large v3 9.18%, and Turbo 18.35%. Turbo's 61.24-second recording accounted for 117 of its 156 errors, including 116 insertions. Its total output had 233 scoring words against 117 reference words. This failure matters even though 18 of its other normalized results were exact.

The final comparison uses the documented `hotwords` API, which reapplies dictionary context to each decode window. The initial-prompt results remain preserved as exploratory artifacts. This API change was motivated by long-recording behavior and dictionary coverage; it is not a claim that any prompt format guarantees good recognition. No individual recording's expected words were selected to improve its score.

Hotwords alone did not solve Turbo's failure. Its long-recording error count rose to 120, and its output repeated a 69-word passage. The separate default Silero VAD run includes filtering time and reduces overall errors from 159 to 61. Its 7.18% WER remains worse than dictionary OFF at 6.12%. VAD was selected after inspecting this corpus, so its apparent improvement needs confirmation on unseen audio. This is a useful diagnostic result, not a reason to hide the failing configuration.

## Downloads, resources and licenses

| Model files | Download MiB | Peak process RSS MiB | Timed load phase |
| --- | ---: | ---: | ---: |
| Moonshine Small | 135.7 | 421 | 1.86 s |
| Moonshine Medium | 256.7 | 591 | 3.16 s |
| Whisper Small.en | 463.6 | 1022 | 6.74 s |
| Distil Large v3 | 1446.2 | 1991 | 15.68 s |
| Whisper Turbo | 1546.5 | 2090 | 16.12 s |
| Whisper Large v3 | 2947.7 | 3497 | 29.00 s |
| Qwen 0.6B | 1793.4 | 2710 | 13.01 s |
| Qwen 1.7B | 4485.2 | 4667 | 19.51 s |
| Nemotron English Q8 | 667.8 | 668 | 0.19 s |

The load phase includes backend imports and model construction inside the runner, but excludes common Python imports, corpus decoding, integrity preflight and warmup. It is not a complete app cold-start measurement. Turbo with VAD uses the same model files; its process RSS was 2,102 MiB and its timed load phase was 18.42 seconds. Qwen peak PyTorch CUDA allocations were 1,973 MiB for 0.6B and 4,486 MiB for 1.7B; those exclude desktop use and CUDA allocator reservations.

Download sizes are the model snapshot files actually fetched, including tokenizer/configuration files. They exclude the runtime and Python environment, and are not the FP16 GPU footprint. Peak RSS measures the whole benchmark process, including Python and loaded libraries; it is not total machine memory or VRAM. Qwen's own peak CUDA allocations are recorded separately in private results. No uniform VRAM measurement was collected across the different native runtimes.

### Measured Large v3 GPU memory

A separate successful probe on 2026-10-03 loaded the same faster-whisper Large v3 snapshot in CUDA FP16 mode and processed all 30 recordings with dictionary hotwords, beam size 5 and no VAD. Windows per-process GPU memory counters measured the actual inference Python PID, which differs from the venv launcher PID. The model does not require a GPU in general; faster-whisper also supports CPU int8, but this quality and latency result used the RTX 3080. [Supported execution modes](https://github.com/SYSTRAN/faster-whisper#usage).

| Phase | Sampled peak dedicated GPU memory | Shared GPU memory |
| --- | ---: | ---: |
| Loaded, before first inference | 4,073 MiB / 3.98 GiB | 76 MiB |
| Recognition | 4,361 MiB / 4.26 GiB | 76 MiB |
| Loaded, idle after recognition | 4,137 MiB / 4.04 GiB | 76 MiB |

There were 26 recognition samples and five samples in each loaded idle phase. The sampler polls approximately once per second, so these are observed peaks and can miss shorter spikes. Shared GPU memory is system RAM exposed to the GPU, not an additional dedicated VRAM allocation. These readings include this process's CUDA/runtime allocations; they are not just weight sizes or PyTorch tensor allocations.

Device-wide `nvidia-smi` usage was 4,726 MiB before launch and peaked at 9,022 MiB during recognition on the 10,240 MiB GPU. Other desktop applications remained open. The device-wide increase is contextual evidence, not a clean model-only measurement. The observed total left about 1.19 GiB free at its peak, so GPU contention deserves testing before keeping this worker resident alongside games or other large GPU workloads. Unloading or terminating the worker would trade memory recovery against the next model load.

The raw samples and successful exit code were saved to ignored `artifacts/local-asr/whisper-large-v3-vram.json`, and remain pending cleanup after automatic approval review blocked deletion. This probe does not establish GPU requirements for other models, CPU performance, an int8 configuration, a cleanup LLM or a different deployment runtime.

All model files had SHA-256 hashes in the experiment's model manifest, with Hugging Face revisions pinned there and in the download script. Both remain pending cleanup after automatic approval review blocked deletion. Moonshine used `quantized_26_08_21` publisher directories. NVIDIA used model revision `ebe59e5a817142986528bbbee5dba8db7b38ed50` and NeMo-Speech.cpp v0.2.0 at `47f43763bb40ec463150dd8d9a788c54f3728bdb`.

Qwen weights use Apache-2.0. Moonshine's English streaming weights use MIT. Whisper and Distil-Whisper publish MIT weights; the Turbo conversion is a third-party conversion of OpenAI's model, which remains a supply-chain consideration before distribution. Nemotron uses the NVIDIA Open Model License, separate from the native runtime license. This benchmark does not authorize bundling any model without its notices and terms. [Qwen card](https://huggingface.co/Qwen/Qwen3-ASR-1.7B), [Moonshine license statement](https://github.com/moonshine-ai/moonshine#license), [OpenAI Whisper license](https://github.com/openai/whisper/blob/main/LICENSE), [Distil card](https://huggingface.co/distil-whisper/distil-large-v3), [Turbo conversion](https://huggingface.co/mobiuslabsgmbh/faster-whisper-large-v3-turbo), [Nemotron card](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b).

The tested NVIDIA model is the English speech recognizer, not a Nemotron text LLM. Qwen was tested through its local Transformers backend with SDPA and FP16. Published server concurrency figures do not represent this Windows single-user latency. Parakeet TDT was excluded from this pass because the selected native release's phrase boosting does not support its TDT decoder. Claiming a dictionary-enabled TDT comparison would have been misleading. [NVIDIA support matrix](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/47f43763bb40ec463150dd8d9a788c54f3728bdb/docs/asr/customization.md), [Qwen inference documentation](https://github.com/QwenLM/Qwen3-ASR).

## Recommendation and next validation

### Inspecting Large v3's failures

The dictionary-on run has 10 substitutions, 3 deletions and 31 insertions, totaling 44 errors. Eighteen recordings match the normalized reference exactly; twelve do not. The two longest failing examples account for 20 of the 44 errors. Extra words dominate the count, but this does not establish that they are all harmless fillers. This inspection compares text to reviewed insertion references; the audio has not been re-listened to classify whether each extra word was spoken or invented.

| Reviewed reference excerpt | Large v3 output excerpt | What matters |
| --- | --- | --- |
| `someone like Minato` | `someone like Monado` | Wrong name. Minato is absent from that recording's saved dictionary, so this does not test a supplied Minato hint. |
| `where Jiraiya's toads live` | `where the driest toads live` | Wrong possessive name despite Jiraiya being present in the dictionary. It did correctly recover Mount Myōboku in the same sentence. |
| `I could see Jiraiya` | `I can see Jiraiya` | Small wording change that affects modality. |
| `port my dictionary in` | `put my dictionary in` | Similar-sounding word substitution. |
| `you can go through quite easily` | `you can burn through quite easily` | Meaning remains close, but the reviewed wording differs. |
| `sealless techniques` | `seal-less techniques` | Word-boundary formatting contributes two scoring errors despite preserving the apparent meaning. |
| `That place may not exist, or it may not exist near you` | `that place may not exist. It may not exist, or it may not exist near you` | An extra repeated clause. Audio inspection is needed before calling it a recognition hallucination. |
| `it's treated more as an exile dumping ground` | `but basically the it's it's treated more as an exile dumping ground` | Extra disfluent wording relative to the edited reference. |

Dictionary hints changed 19 outputs, but the aggregate went from 43 errors OFF to 44 ON. They repaired names such as Onoki and Raikage in some recordings without guaranteeing every name. That makes a separate dictionary-heavy holdout and spoken-verbatim reference particularly useful. Full Large v3 did not show Turbo's 69-word repeated-passage failure in these runs.

Keep the current cloud route as the default. Full Whisper Large v3 is the first local candidate I would take forward for a benchmark-only holdout trial. Its 44 errors are close to saved MAI Verbatim's 45, and its 709 ms median is usable on this GPU. But it still makes 10 more errors than saved MAI Clean and has a 1,561 ms p90. A production replacement claim would be premature, especially with historical dictionary and output-mode differences.

Qwen 1.7B is a second quality candidate. Dictionary context improves it from 56 to 50 errors, matching the saved GPT Transcribe aggregate. It uses approximately 4.4 GiB of model downloads and takes 1.7 seconds at the median in this backend. Qwen 0.6B is smaller but makes six more errors and is not faster in this particular run. Do not infer that the smaller size will always have lower latency across engines.

Whisper Small.en is the compact GPU compromise, with a 464 MiB model snapshot, 286 ms median and 6.82% WER. Its dictionary helps materially, removing 15 errors. Nemotron is the speed candidate at 54 ms median and 194 ms p90, but 7.76% WER and incomplete email hint support make it a poorer fit for the requested cloud replacement. Keep it as a possible future latency experiment, not the default.

I would stop pursuing the tested Moonshine Small/Medium configurations for this corpus. Their 15% to 19% dictionary-on WER is far from the saved cloud baseline, and boosting worsens both. Distil Large v3 also offers a weak tradeoff here. Turbo needs the duplication fix and still trails Small.en in dictionary-on accuracy after VAD. Its good dictionary-off score is not a substitute for the required vocabulary support.

English-only does not decide the winner. Small.en and Nemotron are resource-efficient candidates, but the best quality came from multilingual Large v3. This study compares different model sizes and architectures, so it cannot isolate the resource cost of multilingual training itself. Explicit English selection avoids unnecessary language detection where supported.

The next stage remains outside the app. Benchmark Large v3 and Qwen 1.7B on unseen recordings with the current dictionary, inspect the remaining errors and measure correction effort. If that succeeds, try local cleanup as a separate experiment and then choose a distributable runtime. Defer CPU-only packs and Android until the quality winner is clear. Optional cloud fallback can keep the existing provider route, but it does not turn a weak local recognizer into the serious replacement requested here.

This is a small, familiar corpus from one speaker. One error changes aggregate WER by 0.118 percentage points; one long recording can change the ranking substantially. Two repeat runs check execution stability, not statistical independence. Settings were fixed for the main pass, but the Whisper hint API was inspected using this corpus, so final selection needs unseen recordings.

Before app work, use a fresh holdout set with ordinary messages, dictionary-heavy names, dictated corrections, email addresses, numbers, negation, silence and recordings longer than 30 seconds. Keep the full saved dictionary in every hint-capable run. Record both spoken-verbatim and intended-insertion references, dictionary phrase recovery, duplicated text, dropped phrases, and the time a human spends fixing each result. Compare fresh cloud runs under equivalent output modes only if explicitly requested.

Proposed acceptance gates are no silent hint disablement or truncation, no whole-phrase duplication, and correction effort close to the current cloud route. Use approximately 5% WER as a screening target on the intended-insertion holdout, then make the decision from actual correction effort rather than that number alone. Measure cold start, warm median/p90, longest recording, GPU contention with normal desktop use and cancellation before committing to a worker package.

If a local model passes those gates, a separate benchmark-only cleanup pass can test deterministic normalization and optional local LLM cleanup against the same meaning-preservation checks suggested by Inlay. Keep raw outputs so cleanup cannot hide recognition failures. CPU deployment, Android, packaging and strict network isolation remain separate validation tasks in [the offline research](offline-transcription-research.md).

## Reproduction and retained evidence

The experiment used pinned runtime versions and downloads with paired dictionary runs. Private artifacts held hypotheses, timings, scoring components, input hashes, dictionary audits, aggregate results and an environment inventory. Exploratory initial-prompt and invalid dictionary runs were kept outside the final results directory. All of these artifacts and the reproduction scripts remain pending cleanup after automatic approval review blocked deletion; the summarized findings remain in this report.

No cloud inference requests were made for this experiment. Historical cloud results are explicitly dated. No app feature was implemented, and the primary checkout's ongoing work remains untouched.
