# Groq latency options for Local Whisper

Checked on 2026-09-16. No paid calls were made.

## Short answer

Groq is worth benchmarking at both stages, but cleanup is the larger known bottleneck. On the current 30-sample short-dictation run, MAI Clean took 530 ms median and 883 ms p90. Luna then took 1,310 ms median on the reviewed set. Adding those separately measured medians gives a rough 1.84-second stop-to-paste path before local work.

The best first text test is direct Groq `openai/gpt-oss-120b`. It is a production model rated at about 500 output tokens per second and costs $0.15 per million input tokens and $0.60 per million output tokens. `openai/gpt-oss-20b` is the more aggressive speed test at about 1,000 tokens per second and half the token price. Both require at least `low` reasoning. Groq does not let GPT-OSS disable reasoning, so 20B should be treated as a latency experiment rather than an assumed quality win. [Groq supported models](https://console.groq.com/docs/models), [Groq reasoning controls](https://console.groq.com/docs/reasoning)

For speech, `whisper-large-v3-turbo` is the obvious latency candidate. Groq lists it as a production model with a 216x real-time speed factor, 12% published WER, and a price of $0.04 per audio hour. Full `whisper-large-v3` is rated at 189x real time, 10.3% WER, and $0.111 per hour. Those WER figures come from Groq's model comparison and are not comparable to our 4% MAI result without running the same recordings. [Groq speech-to-text guide](https://console.groq.com/docs/speech-to-text)

## What to try

| Stage | Candidate | Why it belongs in the test | Main risk |
| --- | --- | --- | --- |
| Cleanup | `openai/gpt-oss-120b`, direct Groq, low and medium reasoning | Production status, 500 tokens/s, and enough capability to justify prompt work | Hidden reasoning can erase part of the latency advantage |
| Cleanup | `openai/gpt-oss-20b`, direct Groq, low reasoning | Production status and 1,000 tokens/s make it the fastest public Groq text option | A smaller model may lose conservative editing and correction accuracy |
| Transcription | `whisper-large-v3-turbo`, Groq or OpenRouter pinned to Groq | Production status, 216x real-time factor, and low price | Published WER is worse than full V3, and Whisper may handle dictated formatting and preferred terms less well than MAI |

Groq's speed factor implies about 68 ms of model processing for the normal corpus's average 14.6-second recording on Whisper Turbo. That is only arithmetic, not an end-to-end prediction. Upload time, request setup, queueing, and audio preprocessing remain. Groq recommends 16 kHz mono WAV for lower latency and says specifying the language improves both latency and accuracy. The app already uses short WAV uploads, so this is a close fit. [Groq speech-to-text guide](https://console.groq.com/docs/speech-to-text)

The public transcription API is a completed-file `POST` to `/openai/v1/audio/transcriptions`. Groq describes real-time use cases and publishes real-time speed factors, but its public API reference does not document a WebSocket or incremental-audio transcription endpoint. For the current push-to-talk flow, that is fine. It does not give us partial transcription while the user is still speaking. [Groq API reference](https://console.groq.com/docs/api-reference)

## Likely pipeline effect

These are planning ranges, not benchmark results:

- Replacing Luna while keeping MAI is the most likely immediate win. Cleanup currently contributes about 1.31 seconds at the median, versus 0.53 seconds for MAI on the normal corpus.
- Replacing MAI with Whisper Turbo could trim another few hundred milliseconds if network overhead stays low, but the 216x figure cannot predict the request's fixed overhead.
- Replacing both stages could plausibly put short dictation near or below one second. The public Groq documents do not publish enough end-to-end or time-to-first-token data to claim that result before a direct benchmark.
- The reviewed audio set has much longer and harder recordings. Its measured combined MAI plus Luna median was 11.18 seconds, so it should remain the quality stress test rather than the main interaction-latency estimate.

Groq's default `on_demand` tier can have queue latency at peak times. Paid `flex` keeps the same pricing and raises rate limits, but may fail quickly with HTTP 498 when capacity is unavailable. The enterprise `performance` tier offers provisioned capacity, a 99.9% availability SLA, and a contractual latency guarantee for GPT-OSS 20B and 120B. Groq does not publish the guarantee's numeric latency target. [Groq service tiers](https://console.groq.com/docs/service-tiers), [Groq Performance tier](https://console.groq.com/docs/performance-tier), [Groq Flex processing](https://console.groq.com/docs/flex-processing)

## OpenRouter or direct Groq

OpenRouter exposes Whisper Large V3 and V3 Turbo through its speech-to-text endpoint and lists Groq as a provider. Basic transcription therefore does not require a new direct integration. We can pin the Groq provider for a fair test. [OpenRouter speech-to-text guide](https://openrouter.ai/docs/guides/overview/multimodal/stt), [OpenRouter Groq provider page](https://openrouter.ai/provider/groq)

Direct Groq is still worth testing. It removes one routing hop, exposes Groq's account-level service choices directly, and lets the app use Groq's own data controls. Groq says inference inputs and outputs are not retained by default, except temporary logging for reliability or abuse investigations for up to 30 days. All customers can enable zero data retention for inference endpoints, including audio transcription. [Groq data controls](https://console.groq.com/docs/your-data)

The clean experiment is a four-way interleaved run on the existing audio corpus:

1. MAI plus Luna, the current baseline.
2. MAI plus direct Groq GPT-OSS 120B.
3. Groq Whisper Turbo plus Luna.
4. Groq Whisper Turbo plus direct Groq GPT-OSS 120B.

Record transcription and cleanup separately, including median, p90, failures, cost, WER, exact insertion checks, correction handling, and context-copy failures. Add GPT-OSS 20B only after the 120B direct path is working, because its main value is finding the quality floor.
