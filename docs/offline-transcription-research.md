# Offline transcription research

Closed on 2026-10-03 at the user's request. Keep cloud transcription as the product direction given its measured quality, latency and low cost. No further local-model investigation or integration is planned unless a future breakthrough warrants revisiting it. Cleanup was requested, but automatic approval review blocked deletion of the downloaded models, isolated runtimes, benchmark scripts, copied corpus, raw results and model manifest. Those files remain pending cleanup. This report and the companion benchmark report preserve the findings.

Recommend validating recognition quality before app integration. The follow-up request prioritizes a serious cloud replacement on English dictation over an offline guarantee. The completed [local benchmark study](local-english-asr-benchmark.md) measures local candidates on Liam's existing corpus with dictionary controls. If a model passes the quality gate, use a resident worker owned by the .NET engine. Local cleanup, CPU deployment and Android should pass separate gates. Cloud retry belongs to a separately selected hybrid mode.

Current primary sources support these integration routes. The companion benchmark provides measured results on Liam's Ryzen 7 3700X and RTX 3080; it does not establish performance on other hardware. Hardware tiers and acceptance thresholds below are proposed engineering targets.

## What this checkout establishes

Research date: 2026-10-03. Inspected branch `research/offline-transcription`, commit `6e0f3e014d6d9ffdb95b482b8e623412c139f6bd`. This isolated checkout may lag uncommitted work in the primary checkout. No shortcut rebinding or microphone-test work was inspected in that checkout or changed here. Subsequent authorized benchmarks installed isolated runtimes and downloaded weights into ignored artifacts. No app integration was implemented.

| Area | Observed code | Consequence for offline work |
| --- | --- | --- |
| Desktop | [project](../src/LocalWhisper/LocalWhisper.csproj), [Electron main](../desktop/main.cjs), [packaging](../desktop/package.json) | Windows x64 Electron UI plus self-contained .NET 10 Windows engine, private stdin/stdout messages. Keep inference outside renderer windows. |
| Audio | [Recorder](../src/LocalWhisper/Recorder.cs), [session](../src/LocalWhisper/TranscriptionSession.cs) | Already 16 kHz, mono, signed 16-bit PCM, bounded to five minutes. Current cloud session wraps chunks as WAV and compresses to MP3. Local inference should consume original PCM/WAV. |
| Dispatch | [EngineApp](../src/LocalWhisper/EngineApp.cs), [model fallback](../src/LocalWhisper/ModelTranscription.cs) | Recording currently requires provider keys. Model validation, fallback, saved-audio retry and retranscription assume cloud models. All need an explicit local route. |
| Cleanup | [CleanupService](../src/LocalWhisper/CleanupService.cs), [context](../src/LocalWhisper/TargetContext.cs), [fitting](../src/LocalWhisper/InsertionFitter.cs) | Luna uses OpenRouter and can receive surrounding editor text. Default is off. Existing local fitting can remain useful without an LLM. |
| Other networking | [main](../desktop/main.cjs), [sync](../desktop/dictionary-sync.cjs), [updater](../desktop/updater.cjs) | Credits refresh and dictionary sync run at startup and on timers. Installed builds auto-download updates, first checking after 15 seconds and then every six hours. |
| Local storage | [history](../desktop/history-store.cjs) | Transcript text, raw text, alternatives and metrics use safeStorage encryption. Current recording bytes are stored directly in SQLite; offline does not imply encryption of audio at rest. |
| Android | [voice manager](../android/app/src/main/java/helium314/keyboard/latin/whisper/WhisperManager.kt), [recorder](../android/app/src/main/java/helium314/keyboard/latin/whisper/AudioRecorder.kt), [build](../android/app/build.gradle.kts) | Kotlin HeliBoard fork, AudioRecord PCM/WAV, cloud fallback and optional Luna; periodic dictionary sync. minSdk 21, target/compile SDK 37, existing NDK build and four ABIs. Preserve editor-session guards and cancellation. |

No root desktop license file was found. Android carries [GPL-3.0](../android/LICENSE), inherited [Apache-2.0](../android/LICENSE-Apache-2.0) and [icon notices](../android/LICENSE-CC-BY-SA-4.0). Resolve the desktop project's own distribution license before publishing an offline bundle.

## Speech engine shortlist

| Candidate | Verified capabilities | Recommendation for Local Whisper |
| --- | --- | --- |
| whisper.cpp | C/C++ engine with a C API, CPU-only inference, integer quantization, Windows MSVC/MinGW and Android support. CUDA and Vulkan backends exist. | First desktop candidate. Start with CPU inference and one pinned model. Evaluate GPU packs separately. [Upstream README](https://github.com/ggml-org/whisper.cpp) |
| faster-whisper / CTranslate2 | Python wrapper around CTranslate2; CPU/GPU int8 support. Python 3.9+, PyAV audio decoding, CUDA 12/cuDNN 9 requirements documented by faster-whisper. | Useful benchmark comparison or optional advanced server. Shipping Python and native dependencies is a larger support commitment than a native worker. [faster-whisper](https://github.com/SYSTRAN/faster-whisper) |
| sherpa-onnx | Streaming and non-streaming local ASR with C/C++, C#, Java/Kotlin and JavaScript APIs; Windows x64/ARM64 and Android support. | Second candidate if live partial text or Android CPU efficiency is a requirement. Choose the exact model before claiming language coverage or quality. [Upstream](https://github.com/k2-fsa/sherpa-onnx), [C# examples](https://k2-fsa.github.io/sherpa/onnx/csharp-api/index.html) |

CTranslate2 publishes Windows x64 wheels and requires the Visual C++ runtime. Its installation page currently says cuDNN 8 while faster-whisper's README says current CTranslate2 needs cuDNN 9. Treat this as a documentation mismatch: pin and test the complete engine/CUDA/cuDNN combination before publishing an accelerated package. Do not give users a generic "install latest CUDA" recipe. [CTranslate2 installation](https://opennmt.net/CTranslate2/installation.html), [faster-whisper requirements](https://github.com/SYSTRAN/faster-whisper#requirements)

### Current alternatives worth evaluating

NVIDIA Parakeet TDT 0.6B v3 is a serious desktop comparison, not a speculative model. NVIDIA documents 25 European languages, automatic language detection, punctuation/capitalization and timestamps. It uses CC-BY-4.0 weights. v2 is the English-only comparison. NVIDIA's supplied models target GPU systems; this does not establish acceptable CPU latency in Local Whisper. Measure both on the actual dictation corpus rather than choosing v3 just because it is newer. [v3 model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), [v2 model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2)

NVIDIA's v3 repository currently includes a 714 MB Q8 GGUF artifact alongside 2.51 GB safetensors and NeMo artifacts. These are alternative formats, not three mandatory downloads; GGUF support is engine-specific. [Official files](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3/tree/main)

Qwen3-ASR 0.6B and 1.7B offer 30 languages and 22 Chinese dialects under Apache-2.0. The official package supports Transformers and vLLM, with streaming currently confined to vLLM; timestamps need a separate forced-aligner model. Model-name loading may download weights automatically, and local-directory loading is documented. This is worth a later quality comparison for difficult multilingual dictation, but the official Python/GPU-oriented path is a poor initial Windows/Electron or Android distribution choice. Published high-concurrency throughput claims do not establish single-user latency. [Official model card](https://huggingface.co/Qwen/Qwen3-ASR-0.6B), [Official repository](https://github.com/QwenLM/Qwen3-ASR)

Vosk is a credible small offline/streaming baseline with Android and C#/Node integration. Its small models are typically about 50 MB and need about 300 MB runtime memory; larger models may need up to 16 GB. The English small model listed by its publisher is 40 MB with Apache-2.0 licensing. Other listed models have different licenses. Keep it as a low-resource comparison, not the default without a dictation quality test. [Vosk API](https://github.com/alphacep/vosk-api), [Publisher model catalog](https://alphacephei.com/vosk/models)

## Whisper model and hardware choices

The following are upstream whisper.cpp estimates for ordinary model files. They are not total Local Whisper memory requirements, VRAM guarantees, or measurements of quantized builds. [whisper.cpp memory table](https://github.com/ggml-org/whisper.cpp#memory-usage)

| Model | Download/disk | Upstream approximate model memory | Suggested role |
| --- | --- | --- | --- |
| tiny | 75 MiB | 273 MB | Minimum-resource experiment and mobile comparison |
| base | 142 MiB | 388 MB | Initial desktop CPU candidate |
| small | 466 MiB | 852 MB | Desktop quality comparison |
| medium | 1.5 GiB | 2.1 GB | Optional higher-quality pack after benchmarks |
| large | 2.9 GiB | 3.9 GB | Advanced pack; unsuitable as mandatory download |

The publisher's current files list base.en Q5_1 at about 59.7 MB and small Q5_1 at 190 MB. Large-v3-turbo is about 1.62 GB unquantized or 574 MB Q5_0. These decimal download sizes complement the MiB/GiB table above; they do not establish runtime memory or accuracy. [Publisher model files](https://huggingface.co/ggerganov/whisper.cpp/tree/main).

For English-only use, OpenAI reports better results from `.en` variants, especially tiny/base. Multilingual models need language-specific evaluation. Turbo trades some accuracy for speed and does not support translation to English. OpenAI's reference implementation uses sliding 30-second windows, so a claim of "real-time Whisper" needs an explicit chunking/streaming design. Its reference GPU memory figures do not transfer to whisper.cpp or CTranslate2. [OpenAI model guidance](https://github.com/openai/whisper#available-models-and-languages)

Recommendation: initially compare base.en and small.en for English, base and small for multilingual users, with Q5 variants only after checking quality against the unquantized files. Choose a default from measurements on a modest Windows laptop. An 8 GB system with a modern x64 CPU is a proposed minimum validation tier, not a proven requirement. A 16 GB laptop and an optional 6-8 GB discrete GPU are further test tiers. Include older CPUs, battery power, constrained free RAM and ARM64 if those are declared supported.

Quantization reduces model disk and memory requirements; upstream does not promise a universal speedup. The documented preconverted files use Whisper-specific ggml format, not interchangeable llama.cpp GGUF. Select one engine-compatible file, record its provenance and hash, and avoid runtime conversion requirements for end users. [Quantization](https://github.com/ggml-org/whisper.cpp#quantization), [Model formats and downloads](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md)

## Latency and quality evidence

The faster-whisper README publishes a 13-minute audio benchmark. On an i7-12700K using eight threads and small, whisper.cpp took 125 seconds at 1,049 MB RAM; faster-whisper int8 took 102 seconds at 1,477 MB. On an RTX 3070 Ti 8 GB using large-v2, whisper.cpp took 65 seconds/4,127 MB VRAM and faster-whisper int8 59 seconds/2,926 MB. These comparisons use whisper.cpp v1.7.2 and faster-whisper v1.1.0. They are historical throughput evidence, not current release measurements or the time from releasing a dictation shortcut to receiving text. Batching improves throughput but adds memory and is not the initial single-user design. [Published benchmark and conditions](https://github.com/SYSTRAN/faster-whisper#benchmark)

OpenAI warns that Whisper can hallucinate words, repeat text, and perform unevenly across accents and languages. A local engine does not remove these failure modes. [Whisper model card](https://github.com/openai/whisper/blob/main/model-card.md)

Proposed validation should measure cold start, warm start, model load, decode time, post-stop latency and peak process memory separately. Compare identical audio, language settings and decoder settings. Report p50/p95 by clip length, with 3, 10, 30 and 120 second clips. Evaluate punctuation, names, numbers, code identifiers, accents, noisy rooms, clipped starts/ends, silence, keyboard noise and repeated recordings. Keep raw STT scoring separate from cleanup scoring. Word error rate alone misses edits that reverse a negation or change a number. Any latency threshold is a release gate to agree after the first measurements, not an upstream promise.

## Android feasibility

On-device Android is feasible. whisper.cpp has an official Android example which recommends tiny or base and packages models as app assets. That proves an integration route, not sustained performance in this keyboard. [Android example](https://github.com/ggml-org/whisper.cpp/blob/master/examples/whisper.android/README.md)

sherpa-onnx publishes offline Android APK examples for both streaming and simulated streaming. Its QNN examples need compatible Qualcomm hardware, so an NPU cannot be assumed on all Android devices. The framework's Apache-2.0 license does not cover every supported model. [Android examples](https://k2-fsa.github.io/sherpa/onnx/android/prebuilt-apk.html), [QNN hardware and license note](https://k2-fsa.github.io/sherpa/onnx/android/apk-qnn-asr-streaming.html)

For a concrete CPU baseline, sherpa documents an English Zipformer streaming model with an approximately 179 MB int8 encoder, 1.2 MB int8 decoder and 253 KB int8 joiner. These sizes exclude tokens and runtime memory. Its sample timings lack a sufficiently comparable phone benchmark to justify a Local Whisper SLA. [English model files](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html#csukuangfj-sherpa-onnx-streaming-zipformer-en-2023-06-21-english)

Android's generic SpeechRecognizer may send audio to remote servers. API 31+ has an explicit on-device recognizer factory and availability check, but availability is conditional. The EXTRA_PREFER_OFFLINE flag can have no effect depending on the recognizer, so it is insufficient for an offline guarantee. [RecognizerIntent](https://developer.android.com/reference/android/speech/RecognizerIntent#EXTRA_PREFER_OFFLINE). A bundled engine gives the app control over installed artifacts and cross-device behavior. Treat the system on-device recognizer as a separate optional backend with a tested language/device matrix, not proof that generic system recognition is offline. [Android SpeechRecognizer contract](https://developer.android.com/reference/android/speech/SpeechRecognizer)

Recommendation: stage Android after desktop CPU results. Compare native whisper.cpp tiny/base against one licensed sherpa streaming model on actual low-, mid- and high-tier ARM64 phones. Measure end-to-end keyboard insertion, cancellation, thermal slowdown after repeated use, battery drain, process death and available-memory pressure. Keep inference off the UI thread, release model resources when inactive, and avoid a local cleanup model in the first Android scope.

## Licensing facts

Whisper code and weights use MIT. whisper.cpp and faster-whisper use MIT; CTranslate2 and sherpa-onnx use Apache-2.0. Parakeet v3 weights use CC-BY-4.0, and Qwen3-ASR uses Apache-2.0. Engine licensing and model licensing must be tracked separately, including converted/quantized copies, VAD, tokenizer files and native dependencies. Preserve required notices and attribution in each shipped pack. [Whisper code/weights statement](https://github.com/openai/whisper#license), [whisper.cpp license](https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE), [faster-whisper license](https://github.com/SYSTRAN/faster-whisper/blob/master/LICENSE), [CTranslate2 license](https://github.com/OpenNMT/CTranslate2/blob/master/LICENSE), [sherpa-onnx license](https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE)
## Offline contract and optional cloud use

Proposed product policies:

| Policy | Speech and cleanup | Network behavior |
| --- | --- | --- |
| Offline | Installed local STT, cleanup off or installed local cleanup | No app-initiated external requests. No cloud fallback, account polling, sync, update checks, model fetching or remote retry. Works without API keys. |
| Local with cloud retry | Local STT first, cleanup off/local by default | A separate action lets the user send a failed recording to their configured provider. Explain that audio and dictionary leave the device. Cloud cleanup, if selected, separately discloses transcript and possible editor context. |
| Cloud | Existing provider behavior | Retain existing functionality and its current disclosures. |

Start with manual cloud retry, not an automatic confidence threshold. Local confidence is not calibrated to the current cloud models, and silence or unfamiliar names are poor reasons to send private audio automatically. A later persistent automatic-fallback setting must explicitly authorize uploads and remain unavailable under Offline.

Enforce the policy in both Electron main and .NET, not only by hiding controls. Snapshot it when a recording starts. Cancel in-flight network requests when entering Offline, including startup and periodic work. Check saved recording retries, history alternatives, cleanup, race requests, streaming sessions and all IPC entry points. Do not enqueue deferred uploads that silently run when connectivity returns.

Model installation is a separate, deliberate online setup action. For an air-gapped machine, support import from removable storage with the same integrity checks. Once Offline is enabled, a missing model gives a local setup error and never triggers a download. An app can promise its own network behavior, not that Windows, Android or another installed program makes no requests.

## Windows integration recommendation

Use a resident local worker owned by the .NET engine, with whisper.cpp as the initial runtime. Keep capture, hotkeys, cancellation, context acquisition and paste in the existing engine; Electron displays model availability, progress and timings through restricted IPC. Electron's official guidance supports retaining sandboxing, context isolation and IPC sender validation. [Electron security](https://www.electronjs.org/docs/latest/tutorial/security).

For the first supported integration, place Whisper.net and one pinned whisper.cpp-compatible CPU runtime inside a hidden worker process. It offers managed processing and a familiar .NET API without requiring Python. The current README lists Windows 11/Server 2022+, VC++ 2022 redistributable, and AVX/AVX2/FMA/F16C for its standard x64 runtime, with a NoAvx alternative. Do not assume that the current NuGet build supports every Windows version that Local Whisper supports. Its accelerated packages have separate prerequisites. Pin wrapper and native versions together; avoid AllRuntimes in the default installer. [Whisper.net runtime requirements](https://github.com/sandrohanea/whisper.net#runtimes-description).

The worker is a recommendation for crash isolation and hard cancellation, not an upstream requirement. Use a private pipe for bounded requests and results, keep one model loaded, run one recognition job at a time, drain stderr independently, and terminate the worker if native inference cannot cancel promptly. A native DLL crash must not take down the microphone/paste engine. Report model loading separately from decoding.

First validate Whisper.net cancellation and model-file compatibility. If its Windows baseline, runtime loading or cancellation blocks the release, ship a small pinned native helper using whisper.cpp's C API instead. Calling whisper-cli once per utterance is suitable for the initial benchmark, but repeated model loading would distort interactive latency. Do not add a loopback STT server merely to mimic cloud requests.

Reuse `ITranscriptionSession` where its PCM queue and finish contract fits, but choose the provider before constructing a cloud session. The local path must bypass MP3 compression, cloud key checks, MAI races and cloud fallback. Missing models, native crashes and out-of-memory errors are local errors. GPU-to-CPU recovery can be allowed under Offline, provided it is reported and cancellation remains effective.

Bound dictionary prompting to the actual model/tokenizer limit. The current 1,000-term cloud limit is not a promise that Whisper can use that many terms. Rank relevant terms, expose truncation, and benchmark with/without hints. Prompting is a bias, not a guaranteed spelling rule.

## Optional local cleanup

Ship the first offline release with cleanup off. STT punctuation is useful, but it does not establish safe handling of spoken corrections, formatting commands or editor context. Preserve raw transcripts and allow copying/recovery.

For a later opt-in experiment, use a pinned llama.cpp worker and a small instruction model. Current official Qwen cards provide Apache-2.0 Qwen3.5 0.8B, 2B and 4B candidates. Start with 2B and 4B, treating 0.8B as a lower-memory comparison. Disable thinking explicitly and run text-only inference. Confirm support for the exact converted model in the chosen llama.cpp build. General model-card scores do not measure conservative dictation cleanup. [Qwen3.5-0.8B](https://huggingface.co/Qwen/Qwen3.5-0.8B), [Qwen3.5-2B](https://huggingface.co/Qwen/Qwen3.5-2B), [Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B).

Use Qwen3-4B-Instruct-2507 as an older, text-only non-thinking control, not a claim that it is the latest model. Its card identifies Apache-2.0 licensing and non-thinking-only output. [Qwen3-4B-Instruct-2507](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507).

llama.cpp supports quantized CPU/GPU inference, local chat completions, output constraints and an offline option. Prefer a private worker protocol. If using llama-server for evaluation, bind to 127.0.0.1 with an ephemeral port and authentication, pass an explicit local model path and offline mode, and disable remote model loading and tools. The app owns its process lifetime. [Server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md), [Windows backend builds](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md).

Planning estimates for four-bit weights alone are 0.4 GB for 0.8B, 1 GB for 2B and 2 GB for 4B, calculated as parameters × 4/8 bytes. Actual GGUF downloads and working memory are larger because of metadata, mixed precision, runtime buffers and context. Measure the exact artifacts. Start with a 4K context and a bounded output budget, not the model's advertised maximum context. Reject over-budget input and retain raw text rather than silently truncating long dictation. On an 8 GB computer, default to STT alone; evaluate STT plus 2B cleanup on 16 GB and STT plus 4B on 16-32 GB. These are test tiers, not verified minimums.

Port the cleanup behavior, not merely the current Luna prompt. Evaluate preservation of numbers, negations, names, uncertainty, partial sentences and British spelling; explicit corrections; dictated formatting; and injection-like text in dictation/editor context. Reject blank, truncated, explanatory or copied-context responses and retain raw text on errors. Length and token checks cannot prove semantic fidelity. Keep context capture optional and local.

The [existing cleanup research](ultrafast-cleanup-models.md) found instruction-following and over-editing failures even with much larger cloud models. Reuse the [cleanup evaluator](../tools/cleanup-eval/Program.cs) and reviewed corpus methodology. A small local model must pass the same behavior checks before becoming selectable. Grammar-constrained output controls shape, not meaning.

## Downloads, packaging and licensing

Keep the app installer small and distribute model packs separately. The existing Electron package already puts the .NET engine in extraResources. Include a tested CPU runtime and its required redistribution files; make GPU runtimes optional. Users should not need a Python environment, compiler, CUDA development toolkit or a running third-party service.

Use an app-owned immutable manifest containing model family, language coverage, revision, file names, sizes, SHA-256, license/notices, quantization and compatible runtime versions. Display download size and expected storage before installation. Download to a partial file, support cancellation/resume, verify size/hash, then atomically activate. Keep working models until a replacement is verified. Allow import, export and deletion; store models outside ASAR and the installation directory so app updates do not redownload them.

Pin publisher-owned weights and build/conversion recipes. GGML Whisper files, CTranslate2 directories, ONNX packs and GGUF cleanup files are different formats. Do not treat a matching filename as compatibility. User imports should accept supported data formats, never execute scripts or install arbitrary native libraries. A hash checks integrity against the trusted manifest; it does not make an untrusted manifest trustworthy.

Publish a tested offline bundle containing installer, model pack, CPU dependencies, manifest and notices for USB transfer. GitHub currently requires each release asset to be under 2 GiB, so full large Whisper or some cleanup artifacts need a different host or split archives with final-file verification. Model packs should have independent versions and rollback. [GitHub release limits](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).

Whisper.net and llama.cpp use MIT licenses. Preserve notices and audit the selected runtime's dependency licenses and any GPU redistribution terms. Android's existing GPL obligations remain when distributing modified keyboard binaries. Engine licensing and model-weight licensing are separate checks, including ONNX conversions and third-party quantizations. Do not label every sherpa-supported model Apache-2.0 merely because the engine is. Maintain a bill of materials for each released pack. [Whisper.net license](https://github.com/sandrohanea/whisper.net/blob/main/LICENSE), [llama.cpp license](https://github.com/ggml-org/llama.cpp/blob/master/LICENSE).

Offline privacy also needs honest storage wording. Current history retains plaintext audio bytes locally; temporary files, diagnostic ZIPs, crash logs and backups can retain speech. Keep transcripts out of diagnostics by default, document retention/deletion, and decide whether to encrypt stored audio in a separately scoped change.

## Staged scope and validation gates

The acceptance targets below are proposals. The [completed benchmark](local-english-asr-benchmark.md) covers nine models and a separate Turbo VAD configuration on the available Windows GPU machine. It does not validate deployment on other hardware.

| Stage | Deliverable | Gate before the next stage |
| --- | --- | --- |
| 0. Benchmark only | Initial paired runs completed for Whisper, Qwen, Moonshine and Nemotron. Next test Large v3 and Qwen 1.7B on a fresh English holdout, with full dictionary and separate verbatim/insertion references. No UI or shortcut changes. | Quality and human correction effort justify a local replacement. Verify hints, long recordings, memory and warm/cold behavior. Test the chosen distribution runtime and any CPU fallback separately. |
| 1. Conditional Windows beta | Only after the quality gate, at-stop local STT with cleanup off, one validated model/runtime pack, no key requirement for local recognition, manual import, history/retry/paste/cancel support. If strict Offline is offered, add its explicit policy. | Actual target hardware meets latency and quality goals. For strict Offline, fresh installation with external networking blocked succeeds and every entry point enforces the policy. |
| 2. Distribution and acceleration | Verified download/import lifecycle, offline bundle, one tested GPU backend with CPU recovery, model choice and persistent warm worker. | Corruption, low disk, interrupted downloads, missing DLL/driver, updates/rollback and cold starts recover locally. |
| 3. Optional cleanup and hybrid | Local cleanup behind opt-in only after quality gate, with bounded rewrite validation inspired by Inlay; explicit manual cloud retry and separate cloud cleanup choice. | Cleanup preserves safety-critical details and cannot answer dictated instructions. Measure validator false acceptances and false rejections. Offline never reaches cloud routes. |
| 4. Android pilot | ARM64 local at-stop STT, small pack, no cleanup, bounded recordings and lifecycle integration. | Real-device latency, memory, heat, battery and editor-session tests pass before wider ABI/device support. |
| Later | Streaming previews, broader language packs, additional accelerators or automatic hybrid fallback. | Each has a demonstrated workload benefit and its own privacy/quality checks. |

### Quality and performance protocol

Use the 30 reviewed clips described in [the Whisper Turbo benchmark](whisper-turbo-groq-benchmark.md), with per-recording dictionary snapshots, then expand to at least 100 consented clips. Confirm private audio is available locally before scheduling a run. No private audio or transcripts should enter git. Keep a development subset separate from the held-out acceptance set.

Include 1-3 second utterances, normal 5-20 second dictation, 60-300 second speech, silence, fan noise, clipped starts, quiet speech, accents, technical names, numbers, corrections and multilingual/code-switching samples. Score raw recognition against a human-reviewed verbatim reference. Score cleanup against a separately reviewed insertion reference; do not charge raw STT for fillers intentionally removed by MAI Clean.

Record micro-WER with stated normalization, substitutions/deletions/insertions, exact critical names/numbers/negations, hallucinations on silence and human usability. Compare with current MAI Clean and GPT only using already available results or a separately authorized cloud run. The repo's older 12-file Wispr comparison is explicitly not ground truth. Existing routed Turbo cloud results vary, including 11.29% micro-WER on 2026-09-28; they do not predict local whisper.cpp accuracy or speed.

The initial benchmark used Liam's Ryzen 7 3700X, 24 GiB RAM and RTX 3080 10 GiB. If broader deployment follows, also test an 8 GB laptop CPU, a 16 GB modern CPU, an Intel/AMD integrated GPU and an NVIDIA 6-8 GB GPU. Record CPU model, cores/threads, available RAM, GPU/driver, instruction support, power mode and competing load. Warm each configuration, measure at least 30 repetitions across representative short clips, and keep cold-process/model-load results separate. A 30-sample tail estimate is provisional; expand before making p99 claims.

Measure capture-stop-to-paste p50/p90, worker queue, load, decode, cleanup and paste separately. Also report real-time factor as decode seconds/audio seconds, peak resident memory/VRAM, model disk size, idle cost and cancellation response. Proposed Windows beta targets on its declared supported tier are warm p50 <=2 seconds and p90 <=4 seconds for 5-15 second utterances, long-form RTF <=0.5, and cancellation acknowledgment <=250 ms with no later paste. Compare quality within each tier before claiming a smaller model is sufficient.

For the requested cloud replacement, use approximately 5% micro-WER on held-out intended-insertion references as a screening target, then judge actual correction effort. Compare raw recognition separately against a matched cloud verbatim reference. Report proper-name performance separately and reject whole-phrase duplication or text invented on silence/noise. All runs must prove dictionary hints reach inference without silent disablement or truncation. These are proposed targets, not measured holdout results.

Cleanup needs zero material number/negation/name changes, no answered/executed instructions or leaked context on the curated safety set, and no regression in reviewed insertion correctness. Target <=1 second p50 added latency on its declared hardware tier. A finite test set cannot establish zero failures in general; retain opt-in and raw recovery.

### Offline and failure protocol

Capture attempted DNS, HTTP and WebSocket activity for Electron main, .NET and each worker, with the network enabled so accidental calls are visible. Repeat with outbound access blocked and without API keys. Cold-start, show settings/history, dictate, retry/retranscribe, cancel, leave idle across polling timers and update cadence, learn/undo dictionary entries, restart and quit. Assert no external attempt under Offline, rather than counting only successful requests.

Test transitions into Offline during an upload, cleanup, model download or dictionary sync; block further requests and prevent late output/paste. Test missing/corrupt models, unsupported CPU instructions, native crash, worker hang, OOM, unavailable GPU, stale responses, concurrent sessions and shutdown. Preserve usable audio/history without silently selecting cloud.

For model distribution, test a fresh disconnected Windows installation without preinstalled VC++/GPU development dependencies, low disk space, resume after interruption, hash mismatch, import from USB, failed upgrade and rollback. Pin the tested dependency bundle. Re-run appropriate existing engine/UI checks in the future implementation stage, rebasing against the primary thread's completed shortcut and microphone work first.

For Android, test ARM64 devices with 4, 6 and 8+ GB RAM; include a midrange phone and a recent flagship. Run short utterances and repeated 60-second sessions for ten minutes, measuring cold/warm stop-to-insert, peak process memory, energy and thermal slowdown. A proposed pilot target is p90 <=5 seconds for 5-15 second utterances on the declared supported phone tier. Exercise editor changes, IME hide/show, password fields, screen lock, process death, permission loss and low-memory pressure. Old session results must never insert in a new editor. Keep a shorter pilot recording limit if sustained decoding fails.

## Inspiration from Inlay

Inspected [Inlay at commit 37699e2a6b4081432627640f232ae8b074567668](https://github.com/davis7dotsh/inlay/tree/37699e2a6b4081432627640f232ae8b074567668) on 2026-10-03 after the user suggested it. This was source review only. Inlay is a macOS dictation client with a separate local or remote model server. Its current design is useful evidence that persistent Whisper and optional small-model cleanup can form a complete dictation pipeline. It supplies no comparable Windows/Android benchmark for Local Whisper. [Architecture](https://github.com/davis7dotsh/inlay/blob/37699e2a6b4081432627640f232ae8b074567668/docs/architecture.md).

### Patterns worth adopting

| Inlay pattern observed in source | Recommendation for Local Whisper |
| --- | --- |
| A persistent speech helper loads Whisper and Silero VAD, accepts WAV paths, emits ready/progress/result/error messages and reports included/omitted vocabulary terms. Nonspeech can return an empty successful result. | Use the same explicit worker states and hint diagnostics. Benchmark a Silero nonspeech gate against quiet speech, clipped starts and background noise; do not blindly reuse its thresholds. [Speech helper](https://github.com/davis7dotsh/inlay/blob/37699e2a6b4081432627640f232ae8b074567668/Engine/README.md). |
| The helper supervisor allows one outstanding request, caps response lines, matches request IDs and worker generations, drains stderr, and resets failed or cancelled workers. Shutdown waits for retired children. | Specify these behaviors in the .NET worker contract. Add stale-result, malformed-output, crash, hang and parent-exit checks. Active cancellation can cost the next request a model reload; measure that separately. [Supervisor code](https://github.com/davis7dotsh/inlay/blob/37699e2a6b4081432627640f232ae8b074567668/Server/src/inference/helper-process.ts). |
| Runtime model identities carry file lengths and SHA-256. Verification hashes bounded chunks and caches results against file identity, length and timestamps, with checks for changes during hashing. | Keep immutable pack manifests and explicit readiness. Measure verification separately from model loading. Adapt file identity and process-lifetime handling for Windows rather than copying POSIX code. [Pins](https://github.com/davis7dotsh/inlay/blob/37699e2a6b4081432627640f232ae8b074567668/Server/src/inference/model-pins.ts), [Verifier](https://github.com/davis7dotsh/inlay/blob/37699e2a6b4081432627640f232ae8b074567668/Server/src/inference/model-verification.ts). |
| Dictionary processing prioritizes marked terms and performs non-cascading replacements on the original text, with longer aliases winning. | Recognition hints and replacements should be separate settings. Explicit, narrow aliases could help technical names without an LLM, but this expands the existing dictionary semantics and needs its own quality gate. [Dictionary implementation](https://github.com/davis7dotsh/inlay/blob/37699e2a6b4081432627640f232ae8b074567668/Server/src/domain/dictionary.ts). |
| Optional Qwen uses a persistent MLX helper on Mac and llama.cpp helper on Linux, with Qwen3-4B-Instruct-2507. It fails on input/output overflow and clears per-request state. | Use this exact model as a reproducible cleanup control alongside newer Qwen candidates. Keep model state isolation, deadlines and rejection of partial output. MLX packaging is specific to Mac; the llama.cpp protocol is the more relevant Windows reference. [Text helper](https://github.com/davis7dotsh/inlay/blob/37699e2a6b4081432627640f232ae8b074567668/TextEngine/README.md), [Native implementation](https://github.com/davis7dotsh/inlay/blob/37699e2a6b4081432627640f232ae8b074567668/TextEngine/worker.cpp). |

The strongest addition to the cleanup proposal is Inlay's deterministic acceptance step. Its pipeline applies mechanical cleanup, dictionary rules and list formatting before optional Qwen, then validates the rewrite. The validator checks list markers, numeric values, quantities, dictionary terms, wording overlap, answer retention and negation position. It permits certain explicit corrections through bounded alignment, rather than demanding that every number stay unchanged. Rejection keeps the pre-Qwen text and records a reason. [Text pipeline](https://github.com/davis7dotsh/inlay/blob/37699e2a6b4081432627640f232ae8b074567668/docs/text-correction.md), [Validator implementation](https://github.com/davis7dotsh/inlay/blob/37699e2a6b4081432627640f232ae8b074567668/Server/src/domain/correction.ts).

For Local Whisper stage 3, evaluate a similarly bounded validator before enabling local cleanup. Start with language-specific cases, then test both false acceptances and false rejections. Include legitimate numeric corrections, contrast statements, negation movement, near-spelled names and abandoned clauses. Do not adopt Inlay's overlap constants as proven thresholds. Its documentation explicitly states that these checks cannot prove equivalent meaning or recover a negation omitted by STT. Preserve the current raw-text recovery path.

Its download script pins the model repository revision, resumes to a separate download file, verifies SHA-256 and promotes the file only after verification. This is a concrete reference for stage 2's provisioning workflow, including a separate verified VAD artifact. Keep Local Whisper's offline import path as an additional requirement. [Model download](https://github.com/davis7dotsh/inlay/blob/37699e2a6b4081432627640f232ae8b074567668/scripts/download-model.sh), [VAD packaging notices](https://github.com/davis7dotsh/inlay/blob/37699e2a6b4081432627640f232ae8b074567668/THIRD_PARTY_NOTICES.md).

### Boundaries to retain

Inlay's native speech build explicitly restricts support to macOS and Linux. It disables Whisper's CURL integration and server/examples in that helper. Borrow the process boundary and build-time control over network-capable dependencies; build and validate Windows binaries independently. Parent-death detection and process termination also need Windows-specific handling. [Native build configuration](https://github.com/davis7dotsh/inlay/blob/37699e2a6b4081432627640f232ae8b074567668/Engine/CMakeLists.txt).

Inlay uploads sequenced audio while the user speaks, but queues complete recordings for full-take inference. This is transport streaming, not evidence of incremental Whisper decoding or lower CPU post-stop latency. Its client expects an available server, even when that server runs on the same machine. Keep Local Whisper's first release as an app-owned local worker; a network server and cross-device queue would add scope. Inlay also separates inference completion from confirmed insertion and snapshots settings per take. Apply those principles to local jobs so late results cannot paste into a changed destination. [Recording and delivery lifecycle](https://github.com/davis7dotsh/inlay/blob/37699e2a6b4081432627640f232ae8b074567668/docs/architecture.md).

Inlay's proofreader receives the dictated take and preferred terms, without surrounding documents or clipboard contents. That suggests a simpler first local-cleanup trial for Local Whisper with editor context off. Context-aware insertion can follow after separate validation. Its server retains inference audio, optional original audio and history without filesystem encryption or automatic expiry. Those defaults do not satisfy this document's retention and strict Offline policy by themselves. [Cleanup inputs](https://github.com/davis7dotsh/inlay/blob/37699e2a6b4081432627640f232ae8b074567668/docs/text-correction.md), [Storage](https://github.com/davis7dotsh/inlay/blob/37699e2a6b4081432627640f232ae8b074567668/docs/architecture.md).

Inlay's project license is MIT, which permits reuse subject to its notice requirements. Its third-party notices separately identify Whisper, Silero, Qwen and native/runtime dependencies. Any future adaptation must retain applicable notices and audit the actual distributed model conversion and binaries. No Inlay source was copied into Local Whisper during this research. [License](https://github.com/davis7dotsh/inlay/blob/37699e2a6b4081432627640f232ae8b074567668/LICENSE), [Dependency notices](https://github.com/davis7dotsh/inlay/blob/37699e2a6b4081432627640f232ae8b074567668/THIRD_PARTY_NOTICES.md).

This strengthens the worker recommendation and adds a concrete cleanup-validator reference. The user's later direction makes measured recognition quality the first gate; an offline app release is conditional on passing it. Validate optional cleanup and Android independently.

## Decision after research

Measured dictionary-on WER is 5.18% for full Whisper Large v3, 5.88% for Qwen 1.7B and 7.76% for the corrected Nemotron English Q8 artifact. Moonshine's tested configurations scored 15.29% and 18.59%. Large v3 is the first holdout candidate, but saved MAI Clean scored 4.00%, so these runs do not justify replacing the default cloud route. The [full comparison](local-english-asr-benchmark.md) documents timings, resource use, historical-baseline differences, the rejected Nemotron dictionary run and Turbo's duplication failure.

The [benchmark study](local-english-asr-benchmark.md) supersedes the initial proposal to choose base.en or small.en before measurements. Keep app integration deferred until a local model demonstrates acceptable correction effort on a fresh holdout set. A .NET-owned resident worker remains the integration boundary; choose its runtime from the winning measured model. Treat Android as a later ARM64 pilot and local cleanup as an independent opt-in experiment.

The completed Large v3 FP16 memory probe on the RTX 3080 measured a sampled per-process dedicated VRAM peak of 4.26 GiB during recognition and 4.04 GiB while loaded afterward. Total device usage, including the user's other applications, peaked at 8.81 GiB of its 10 GiB. This makes resident-worker memory policy a practical requirement on this machine. The [benchmark's GPU memory section](local-english-asr-benchmark.md#measured-large-v3-gpu-memory) records the counters, phases and sampling limits. CPU int8 is supported by the benchmark backend but remains unmeasured for this model; local cleanup would need a separate memory budget.

The unresolved decisions are actual target hardware and supported Windows versions, the winning model/quantization, domain-name accuracy, trustworthy conversion/distribution artifacts, worker cancellation behavior, and Android thermal limits. None blocks documenting the design; each blocks a production claim until the staged validation supplies evidence.
