# Dictation latency investigation, 11 September 2026

The original client sends uncompressed WAV encoded as base64 JSON. A Windows SAPI fixture exercises the actual transcription client with the saved OpenRouter key, printing only timings and character counts.

## Measured observations

| Request | Audio duration | End-to-end client time | Result |
| --- | ---: | ---: | --- |
| Original WAV JSON | 8.4 s | 1.464 s | Success |
| Original WAV JSON | 33.8 s | 90 s | Timed out while writing the request body |
| Buffered WAV JSON, known content length | 8.4 s | 2.047 s | Success |
| Buffered WAV JSON, known content length | 33.8 s | 30 s | Timed out while writing the request body |
| MP3 JSON, known content length | 8.4 s | 1.291 s | Success |
| MP3 JSON, known content length | 33.8 s | 1.422 s | Success |

For the successful 33.8-second request, MP3 audio was 202,607 bytes before base64 encoding. Compression took 58 ms, request preparation 4 ms, connection work 1 ms, transport writes 13 ms, waiting for response headers 1,346 ms, and transcript parsing less than 1 ms. The transcription returned 427 characters.

These are individual observations, not percentile measurements or a guaranteed latency target. The fixture uses 22.05 kHz audio; the app's native 16 kHz compression path is also covered by automated pipeline tests. The failure stack locates the stall in transport writes, but does not identify whether the remote service, a proxy, or the network caused backpressure. Known request length alone did not resolve it. Reducing the uploaded payload did.

## Changes

- Compress to 48 kbps MP3 in memory and prepare requests off the UI thread.
- Hide the toolbar while idle and immediately after sending paste.
- Move the existing 700 ms clipboard restoration delay out of the path that blocks the next dictation.
- Collect live timing spans, upload size, audio duration, and UI heartbeat gaps.
- Offer optional transcription at pauses, with at most two concurrent requests, ordered assembly, cancellation, and no partial paste after failure.

OpenRouter documents a file-transcription endpoint and a microphone approach based on chunks at silence. A realtime GPT Transcribe WebSocket through OpenRouter was not established by its documentation. The optional mode uses file requests and does not claim token streaming.

## Reproduction and regression commands

```powershell
dotnet run --project tests/LocalWhisper.Tests -c Release -- --idle
dotnet run --project tests/LocalWhisper.Tests -c Release
dotnet run --project tests/LocalWhisper.Tests -c Release -- --desktop
dotnet run --project tests/LocalWhisper.Tests -c Release -- --benchmark
```

The idle test failed before the visibility fix. The benchmark makes real API requests. Other tests use fake HTTP handlers, except the optional desktop checks which also use a local microphone and test window. Windows may deny programmatic foreground focus, in which case native paste verification is explicitly skipped.

Sources: [OpenRouter speech-to-text](https://openrouter.ai/docs/guides/overview/multimodal/stt), [OpenRouter microphone guidance](https://openrouter.ai/docs/cookbook/building-agents/long-horizon-agents), [OpenAI GPT Transcribe](https://developers.openai.com/api/docs/models/gpt-transcribe).
