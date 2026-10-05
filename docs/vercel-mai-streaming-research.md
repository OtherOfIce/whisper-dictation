# Vercel MAI streaming transcription research

Checked on 2026-10-03 against Vercel documentation and the public AI SDK source.
This note supports an isolated benchmark; it does not recommend changing the
application's transcription provider yet.

## Model and availability

Use `microsoft/mai-transcribe-2-streaming`. Vercel lists Azure as its provider
and charges $0.54 per audio hour, equivalent to $0.009 per minute. The listed
release date is 2026-10-01. Partials can change as new audio arrives; final
results confirm text. [Vercel model page](https://vercel.com/ai-gateway/models/mai-transcribe-2-streaming)

The recorded-file baseline `microsoft/mai-transcribe-2` currently costs
$0.10 per audio hour on Vercel AI Gateway. Use that rate only for this model's
baseline cost estimate. [Vercel file model pricing](https://vercel.com/ai-gateway/models/mai-transcribe-2)

The launch announcement confirms the qualified model ID and says inference
has no Gateway platform markup. Its example uses 16 kHz PCM and replaces the
displayed text for each partial. [Microsoft model launch](https://vercel.com/changelog/microsoft-ai-models-are-now-available-on-ai-gateway)

Speech transcription remains beta with gradual team rollout. A valid key
does not guarantee this model is enabled for that team. Recorded-file REST
transcription and streaming have different model sets. The REST transcription
endpoint returns one complete JSON result and is not the streaming transport.
The docs state minimum general transcription versions of `ai` 7.0.31 and
`@ai-sdk/gateway` 4.0.23; use a release that actually exposes
`experimental_streamTranscribe` if choosing the SDK.
[Gateway speech-to-text documentation](https://vercel.com/docs/ai-gateway/modalities/speech-to-text)

## Audio and MAI behavior

MAI streaming accepts raw signed 16-bit little-endian mono PCM at 16000 or
24000 Hz. Do not send WAV headers, MP3, or other compressed-file bytes as PCM.
The default is 24000 Hz. The SDK emits append-only finalized deltas and
replaceable partial text following the latest delta. MAI does not detect
pauses on the server; the SDK commits once when input ends, then emits a final
transcript. Audio duration is computed from input bytes.

The documented streaming option is `providerOptions.azure.language`, a hint
such as `en`; omission allows language detection. File-only options such as
timestamps produce warnings. Do not assume the file model's `clean`, diarization,
word timestamps, or phrase-list behavior exists in streaming.
[Azure provider streaming documentation](https://ai-sdk.dev/providers/ai-sdk-providers/azure#mai-transcribe-2-streaming)

## WebSocket protocol for a local benchmark

The Gateway SDK constructs this URL:

```text
wss://ai-gateway.vercel.sh/v4/ai/transcription-model?ai-model-id=microsoft%2Fmai-transcribe-2-streaming
```

It sends the start JSON frame, binary PCM frames of at most 64 KiB, and an
audio-done JSON frame. It waits for `finish` before closing. A socket close
without `finish` is an error. An `error` event stops further audio transmission.
[Gateway transcription transport source](https://github.com/vercel/ai/blob/main/packages/gateway/src/gateway-transcription-model.ts)

Offer these WebSocket subprotocols, where the second contains the local API
key or a minted client token:

```text
ai-gateway-transcription.v1
ai-gateway-auth.<credential>
```

Optional team scope uses `ai-gateway-team.<base64url-team-id-or-slug>` without
base64 padding. The Gateway converts the credential subprotocol to Bearer
authentication. Avoid logging the subprotocols or request headers.
[Gateway WebSocket authentication source](https://github.com/vercel/ai/blob/main/packages/gateway/src/gateway-realtime-auth.ts)

Send exactly one start text frame first, followed by raw binary audio:

```json
{
  "type": "transcription-stream.start",
  "inputAudioFormat": { "type": "audio/pcm", "rate": 16000 },
  "providerOptions": { "azure": { "language": "en" } }
}
```

Signal input completion with:

```json
{ "type": "transcription-stream.audio-done" }
```

Server text frames contain one flattened JSON stream part. Unknown types
should be ignored for forward compatibility. The server closes with 1000
after `finish`, or sends an error and closes with a different code. The source
says Gateway rejects frames over 256 KiB and recommends a client maximum of
64 KiB. [Streaming envelope source](https://github.com/vercel/ai/blob/main/packages/provider-utils/src/transcription-stream-envelope.ts)

| Event | Required payload | Meaning |
| --- | --- | --- |
| `stream-start` | `warnings` array | Accepted session and option warnings |
| `transcript-delta` | `delta` string | Append finalized text |
| `transcript-partial` | `text` string | Replace current provisional text |
| `transcript-final` | `text` string | Final segment or utterance |
| `finish` | `text`, `segments` | Authoritative completed transcript |
| `error` | `error` | Failed request |
| `response-metadata` | No mandatory field | Response identifiers and metadata |
| `raw` | `rawValue` | Optional native provider message |

Transcript events may include IDs and provider metadata. Final and partial
events may include timing and channel information. `finish` may also include
language, duration, usage, and provider metadata. Do not append both deltas
and final text into the same transcript, since they can describe the same
content. Use `finish.text` for scoring.
[Stream part type definitions](https://github.com/vercel/ai/blob/main/packages/provider/src/transcription-model/v4/transcription-model-v4-stream-part.ts)

## Client tokens and SDK consumption

For a future browser experiment, mint a client secret server-side with
`gateway.experimental_transcription.getToken({model})`. It is single-use,
model-bound, defaults to a 60-second opening lifetime, and permits at most
300 seconds. The browser should receive only that token.
[Gateway browser setup](https://vercel.com/docs/ai-gateway/modalities/speech-to-text#stream-from-the-browser)

The SDK mints with `POST /v1/realtime/client-secrets` at the Gateway origin,
Bearer authentication, and JSON body containing `model`,
`routeKind: "transcription"`, and optional `expiresIn` seconds. The response
contains `token` and optional epoch-second `expiresAt`. The SDK constructs
the WebSocket URL locally. `AI_GATEWAY_API_KEY` is the default credential
environment variable.
[Gateway provider source](https://github.com/vercel/ai/blob/main/packages/gateway/src/gateway-provider.ts)

The SDK's `fullStream` has one consumer. Consume it before awaiting final
result promises; awaiting a result first consumes the stream internally.
[AI SDK transcription documentation](https://ai-sdk.dev/docs/ai-sdk-core/transcription#streaming-transcription)

## Benchmark implications

Replay recorded speech at real time to measure live behavior. Report connection
setup time, first nonempty transcript update, first finalized delta, and time
from audio-done to finish separately. A burst-upload run answers a different
question and should be labeled accordingly. Score the completed transcript
against the existing references and retain timed events for inspection.

Estimated cost is audio seconds multiplied by 0.54 / 3600, not measured billing.
No official Gateway session-duration ceiling or MAI streaming phrase-biasing
support was established from the sources above. Treat those as live-test
questions, not inherited limits from the recorded-file model.
