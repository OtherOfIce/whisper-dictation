# Muse Voice Transcribe research

Verified against Meta's public documentation and Meta's official cookbook on 17 September 2026.

## Bottom line

The product is **Muse Voice Transcribe**, model ID `muse-voice-transcribe-1.0`, hosted by Meta Model API. Live transcription uses a provider-specific WebSocket rather than the OpenAI-compatible APIs used by the rest of Meta Model API. The WebSocket accepts paced raw PCM and emits revisable partial transcripts plus turn events. Meta's current price is $0.18 per processed audio hour, rounded down to whole seconds. Meta has an email spend alert but no hard spending cap and no documented billing or usage API. The application therefore needs its own session timer, processed-audio ledger, warning threshold, hard local cutoff, and cleanup watchdog from the first prototype. [Models](https://dev.meta.ai/docs/models) · [Speech-to-text guide](https://dev.meta.ai/docs/speech-to-text) · [Pricing](https://dev.meta.ai/docs/pricing-rate-limits) · [Spend-limit help](https://dev.meta.ai/help/billing/spend-limit-alert)

## Product, endpoints, and authentication

| Item | Contract |
|---|---|
| Product | Muse Voice Transcribe |
| Model ID | `muse-voice-transcribe-1.0` |
| Live endpoint | `wss://api.meta.ai/v1/asr/realtime` |
| Existing recording endpoint | `POST https://api.meta.ai/v1/asr/transcribe` |
| Live authentication | Put `"Bearer <MODEL_API_KEY>"` in `authorization.accessToken` in the first JSON frame. The WebSocket ignores an HTTP `Authorization` header and API-key query parameters. |
| File authentication | `Authorization: Bearer <MODEL_API_KEY>` header |
| Optional correlation | `sessionId` query parameter. Meta generates and acknowledges one if omitted. |

The client must send the live handshake within 10 seconds and wait for its `{ "sessionId": "..." }` acknowledgement before sending audio. Session configuration is then fixed. Meta's API-key guidance says to use a distinct key per application, never embed one in mobile or browser client code, and proxy requests through a controlled server because client code is visible to users. That guidance conflicts with a simple Android key field that connects directly to Meta. A direct-key prototype is possible, but it should be treated as a local developer tool, not a safe production design. [Realtime API](https://dev.meta.ai/docs/api-reference/voice/realtime) · [Voice schemas](https://dev.meta.ai/docs/api-reference/voice/schemas) · [Authentication](https://dev.meta.ai/docs/authentication)

There is one first-party inconsistency to catch in the smoke test. Meta's current API guide and schema require `Bearer ` inside `authorization.accessToken`, while the official cookbook utility currently passes the raw key. Follow the current API reference, and make authentication the first live assertion rather than copying the cookbook blindly. [Realtime API](https://dev.meta.ai/docs/api-reference/voice/realtime) · [Official client utility](https://github.com/meta-models/meta-model-cookbook/blob/main/06_muse_voice/01_voice_api_fundamentals/utils.py)

## SDK and transport support

Meta documents OpenAI and Anthropic SDK compatibility for its HTTP text APIs, but Muse Voice realtime is a separate WebSocket protocol. Meta's official Python example uses the generic `websockets` library, not an OpenAI or Meta client SDK. The official cookbook calls realtime voice the one part of Model API that is not an HTTP endpoint. On Android, implement the wire contract with the project's WebSocket client rather than trying to route it through the OpenAI SDK. The non-streaming endpoint is ordinary multipart HTTP and can use a normal HTTP client. [SDKs and libraries](https://dev.meta.ai/docs/sdks) · [Official Meta cookbook](https://github.com/meta-models/meta-model-cookbook/tree/main/06_muse_voice/01_voice_api_fundamentals)

## Audio contract

Realtime audio is raw, signed 16-bit little-endian mono PCM in binary WebSocket frames:

- `PCM_24KHZ`: 24 kHz, 48,000 bytes/second, the engine-native rate.
- `PCM_16KHZ`: 16 kHz, 32,000 bytes/second, resampled by the server.

Frames have no header, timestamp, sequence number, or semantic boundary. Meta's example uses 80 ms frames, but its official cookbook says frame size is not a server requirement. Audio must be paced at approximately realtime speed. Buffered audio cannot be blasted at network speed. A live source must continue sending PCM silence during gaps.

The file endpoint accepts a RIFF/WAVE container containing mono, signed 16-bit integer PCM at 16 or 24 kHz. It rejects unsupported WAV data, recordings over 10 minutes, and request bodies over 32 MB. [Speech-to-text audio details](https://dev.meta.ai/docs/speech-to-text#send-audio) · [Voice schemas](https://dev.meta.ai/docs/api-reference/voice/schemas) · [Official client utility](https://github.com/meta-models/meta-model-cookbook/blob/main/06_muse_voice/01_voice_api_fundamentals/utils.py)

## Handshake and events

A suitable low-latency dictation handshake is:

```json
{
  "authorization": { "accessToken": "Bearer <MODEL_API_KEY>" },
  "audioEncoding": "PCM_24KHZ",
  "model": "muse-voice-transcribe-1.0",
  "mode": "ENDPOINTING",
  "partialMode": "CUMULATIVE",
  "emitAudioProgress": true
}
```

Optional `keywords` and `languageBias` string arrays can bias recognition. They cannot change during a session. Muse Voice supports 25 documented languages and code-switching. It returns turn-level timestamps, not word timestamps or confidence scores. [Speech-to-text guide](https://dev.meta.ai/docs/speech-to-text) · [Voice schemas](https://dev.meta.ai/docs/api-reference/voice/schemas)

Three modes are available:

| Mode | Completion rule | Fit |
|---|---|---|
| `PUSH_TO_TALK` | Send `endStream`; final `transcript` has `final: true` | One controlled utterance |
| `ENDPOINTING` | Model emits `speechStart`, partial `transcript` events, `speechEnd`, then `speechComplete` | Best match for low-latency dictation |
| `DIARIZATION` | Same turn lifecycle plus `speaker` labels | Multi-speaker audio; Meta says it is not tuned for low-latency commands |

Server event types are `transcript`, `speechStart`, `speechEnd`, `speechComplete`, `speaker`, `audioProgress`, and `error`. A successful handshake acknowledgement is the only server JSON frame without `type`.

Important state rules:

- With `CUMULATIVE`, each partial replaces the prior hypothesis. It is not an append-only delta and can revise or remove text.
- `speechEnd` is only a boundary. The durable text for endpointing and diarization comes from `speechComplete`.
- Turns can overlap in delivery. Key durable state by `turnId`; do not assume completion order.
- Partial `transcript` events have no `turnId` and belong to the most recently opened turn.
- Ignore unknown event types so additive protocol changes do not break the client.
- `audioProgress.audioProcessedMs` reports processing progress, not a word timestamp. It is the best provider-supplied input for an in-app live cost estimate.

[Speech-turn lifecycle](https://dev.meta.ai/docs/speech-to-text#detect-speech-turns-with-endpointing) · [Voice event schemas](https://dev.meta.ai/docs/api-reference/voice/schemas)

## Session lifecycle, cancellation, and failure handling

Graceful completion means draining the capture queue, sending `{"type":"endStream"}`, sending no more audio, and continuing to read until Meta closes the socket with code `1000`. `endStream` half-closes input so pending results can flush. Closing the socket also stops input, but Meta warns that this can discard pending events. There is no client-side per-turn commit, resume token, or documented cancel endpoint for realtime voice. A reconnect creates a new session. [Lifecycle](https://dev.meta.ai/docs/speech-to-text#manage-the-session-lifecycle) · [Realtime API](https://dev.meta.ai/docs/api-reference/voice/realtime)

| Condition | Provider behavior |
|---|---|
| No handshake within 10 seconds | Close `1008` |
| More than 5 seconds of sent-audio backlog | Close `1008` |
| Ingress remains below realtime for 10 seconds | Close `1008` according to Meta's official cookbook |
| Input stops without `endStream` | Server eventually closes the idle input |
| Session reaches 60 minutes | Close `1011`; reconnect before this limit |
| Rate limit | Close `1013` |
| Normal completion | Close `1000` after final results |

Close `1008` requires fixing the request or pacing rather than retrying unchanged. Close `1011` is retryable unless it reports the planned 60-minute limit. Close `1013` requires exponential backoff with jitter. Log every error with `sessionId`. [Realtime close codes](https://dev.meta.ai/docs/api-reference/voice/realtime#close-codes) · [Official cookbook limits](https://github.com/meta-models/meta-model-cookbook/blob/main/06_muse_voice/01_voice_api_fundamentals/README.md)

Application cleanup should be stricter than the provider limit. Stop and release the Android recorder on button release, keyboard/service teardown, lifecycle cancellation, network loss, socket failure, and an app-controlled maximum duration. Bound the audio queue and drop stale audio rather than allowing an unbounded backlog. Use a short close deadline; after it expires, close the socket and mark the session incomplete. These are application safeguards inferred from Meta's pacing and close semantics, not extra provider guarantees.

## Pricing, usage data, and spend controls

Meta charges **$0.18 per hour**, equal to **$0.003 per minute**, **$0.00005 per second**, or **$0.00000005 per millisecond** before billing rounding. Streaming, file transcription, Standard, and zero-data-retention requests have the same price. The Contributor discount is not available. Meta bills audio actually processed, rounds down to whole seconds, and does not bill a request that fails before producing a transcript or is rejected with `429`. Platform free-tier credits can apply. [Pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits) · [Speech-to-text pricing](https://dev.meta.ai/docs/speech-to-text#pricing)

Provider-returned metering data is limited:

- Live events carry `audioProcessedMs`. `audioProgress` makes progress independent of speech activity visible, and other transcript/turn events also carry `audioProcessedMs`.
- The buffered file response carries `audioDurationMs`.
- The closest estimate of Meta's billed amount is `floor(maxAudioProcessedMs / 1000) * $0.00005` for realtime and the equivalent calculation from `audioDurationMs` for file transcription. This follows the documented whole-second round-down rule but is still an estimate, not invoice data.
- The documented voice response and event schemas do not include a currency cost, billed seconds, remaining credit, accumulated team spend, or invoice amount.
- Meta's public API reference lists inference, files, models, and status resources. It documents no usage, billing, budget, or spend endpoint.
- The dashboard has a Usage page and a monthly email spend alert. Meta explicitly says the alert does not cap usage and customers owe costs beyond the alert amount. The help page describes the Usage view as token and request reporting, so it should not be assumed to supply programmatic or realtime audio-cost data.

[Voice schemas](https://dev.meta.ai/docs/api-reference/voice/schemas) · [API resource index](https://dev.meta.ai/docs/api-reference) · [Usage dashboard help](https://dev.meta.ai/help/usage-and-limits/api-usage) · [Spend-limit help](https://dev.meta.ai/help/billing/spend-limit-alert)

### Safeguard design for the prototype

Use a local, conservative cost ledger because Meta does not provide a hard cap:

1. Generate a unique local session ID and pass it as Meta's `sessionId` for correlation.
2. Record wall-clock capture duration, PCM bytes sent, highest acknowledged `audioProcessedMs`, close code, final-result status, and estimated cost for every attempt, including crashes and abandoned sessions.
3. Estimate the current session from `max(audioProcessedMs)`, falling back to `bytesSent / bytesPerSecond`. Round the estimate **up** to a whole second for safety even though Meta rounds its bill down.
4. Persist the ledger before opening the socket and update it periodically, not just on normal close. On startup, reconcile any session left open as interrupted.
5. Show a warning at a configurable daily or monthly amount. Enforce an app-local hard cap by refusing a new session and closing an active one when the conservative estimate reaches the cap.
6. Set a separate maximum session duration measured in minutes, not anywhere near Meta's 60-minute ceiling. A stuck microphone then has a known maximum cost.
7. Do not automatically reconnect after a user stop, app teardown, invalid request, or local cost cutoff. Cap retry count and total retry time for retryable failures.
8. Also configure Meta's dashboard email alert, while treating it as delayed notification rather than enforcement.

At $0.18/hour, a continuously processed 24-hour stream is about $4.32 and a 30-day stream is about $129.60 before credits. A 10-minute local session cap costs at most about $0.03 per uninterrupted session. Those figures assume the current public price and continuous billable processing.

## Rate and access limits

Muse Voice uses team-wide stream limits shared by realtime and file transcription, not token limits: 128 concurrent streams and 16,000 streams started per hour. Multiple keys in one team share quotas and usage. Realtime rejection closes with `1013`; file rejection returns HTTP `429`. [Pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits#rate-limits-for-muse-voice-transcribe)

Meta Model API is available only where Meta enables it and billing is supported. The current geographic policy designates Muse Voice Transcribe as a Standard Model. It lists no Muse-specific exclusion beyond the general restricted territories: Afghanistan, Belarus, Cambodia, China including Hong Kong and Macau, Cuba, Eritrea, Ethiopia, Haiti, Iran, Iraq, Libya, Myanmar, Nicaragua, North Korea, Pakistan, Russia, Somalia, Syria, Crimea/Donetsk/Luhansk, Venezuela, and Western Sahara. Meta can change availability and forbids bypassing geographic controls. [Geographic Use Policy, updated 2 September 2026](https://dev.meta.ai/legal/geographic-use-policy) · [Supported-countries help](https://dev.meta.ai/help/accounts-and-login/supported-countries)

## Prototype recommendation

Prove the wire contract in the small Windows .NET console prototype before changing either production backend. The existing desktop engine already uses NAudio and 16 kHz mono PCM, so this checks the new WebSocket transport with fewer unrelated changes. Start in `PUSH_TO_TALK` mode to match the current shortcut lifecycle. A later `ENDPOINTING` experiment can measure how well early turn completion fits dictation. Use cumulative partials and `emitAudioProgress: true` in both cases.

The prototype should show socket state, microphone state, `sessionId`, capture seconds, provider-processed seconds, estimated session cost, persisted daily estimate, and the active warning or hard cap. It should include forced tests for user stop, process cancellation, network loss, handshake rejection, stalled sends, timeout cutoff, and relaunch after an interrupted session.

Do not put a long-lived application-owned Meta key directly in the shipped Android app. Meta explicitly recommends a server proxy for mobile clients. A local BYOK desktop app can store the user's own key with Windows data protection, as it already does for OpenRouter, but it must never send that key to Electron's renderer. The spike reads a developer key from the process environment only. Android production architecture still needs a controlled credential boundary before release.
