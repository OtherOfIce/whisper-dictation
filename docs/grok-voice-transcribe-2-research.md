# Grok Voice Transcribe 2.0 research

Checked on 2026-09-18. xAI's release notes date the launch to September 17,
2026. No paid calls were made and no application code was changed.

## Recommendation

Benchmark it now, but start with xAI's file-upload REST endpoint. Contrary to
the initial assumption, `grok-voice-transcribe-2.0` is not streaming-only.
The same model accepts an MP3, WAV, or another supported file through
`POST https://api.x.ai/v1/stt`, so the first quality and completed-request
latency comparison does not need a streaming rewrite.

Treat live streaming as a second experiment. It could reduce perceived
latency because audio reaches xAI while the user is still speaking, but it
changes capture, session, partial-result, endpointing, cancellation, and
failure handling. xAI has not published a 1.0-versus-2.0 accuracy or latency
benchmark. Its only model-specific quality claim is that 2.0 is its "best
transcription model." That is enough reason to test, not enough reason to
replace the current path.

OpenRouter does not expose 2.0 as of this check. Its live transcription model
catalog contains `x-ai/grok-stt-1.0`, released July 23, at $0.10 per audio
hour. There is no `x-ai/grok-stt-2.0` or `x-ai/grok-voice-transcribe-2.0`
entry. OpenRouter's 1.0 route is synchronous and uses its OpenAI-compatible
`POST /api/v1/audio/transcriptions` endpoint. The cleanest immediate 2.0
benchmark therefore calls xAI directly.

## What xAI released

The versioned model ID is `grok-voice-transcribe-2.0`. It is opt-in. Omitting
`model` still selects `grok-voice-transcribe-1.0`, for both REST and streaming.
The dedicated 2.0 model page lists availability in `us-east-1`, `eu-west-1`,
and `us-saltlake-2`. The general STT page describes the service as Audio to
Text and lists the public limits and prices below.

| Property | REST file transcription | Live transcription |
| --- | --- | --- |
| Endpoint | `POST https://api.x.ai/v1/stt` | `wss://api.x.ai/v1/stt` |
| Model selection | multipart field `model=grok-voice-transcribe-2.0` | connection query parameter `model=grok-voice-transcribe-2.0` |
| Authentication | `Authorization: Bearer <xAI key>` | same header during the WebSocket handshake |
| Input | multipart `file` or server-fetched `url` | raw binary audio frames |
| Output | one JSON response | JSON transcript events |
| List price | $0.10 per audio hour | $0.20 per audio hour |
| Published limit | 10 requests/second | 10 connection requests/second and 100 concurrent sessions per team |

xAI labels the REST path "batch," but it is a synchronous single-call file
transcription endpoint, not the separate asynchronous xAI Batch API. The
client sends a recording and receives the transcript in that response. There
is no job creation or polling step.

## REST endpoint details

The request is `multipart/form-data`. Either `file` or `url` is required, and
xAI warns that `file` must be the final multipart field because later options
may be ignored for streamable uploads.

Useful request options include:

- `format=true` plus `language` for inverse text normalization of numbers,
  currencies, and units
- repeated `keyterm` values for vocabulary biasing, up to 100 terms of 50
  characters each
- `diarize=true` for speaker indexes on word records
- `multichannel=true` for independent per-channel transcription, up to eight
  channels
- `filler_words=true` to retain fillers, which the service removes by default
- `vad_threshold` from 0 to 1, with 0 disabling the speech gate and 0.5 as the
  REST default

The JSON response contains `text`, a detected BCP-47 `language`, audio
`duration`, and word records with `text`, `start`, and `end`. Words can also
carry confidence and speaker values. Multichannel requests add per-channel
transcripts.

### File formats and limits

REST accepts nine auto-detected container formats: WAV, MP3, OGG, Opus, FLAC,
AAC, MP4, M4A, and MKV. MKV is limited to MP3, AAC, or FLAC audio codecs. It
also accepts headerless PCM16 little-endian, G.711 mu-law, and G.711 A-law when
`audio_format` and `sample_rate` are supplied. Supported sample rates are 8,
16, 22.05, 24, 44.1, and 48 kHz. The maximum file size is 500 MB. xAI does not
publish a maximum audio duration on the STT page.

The documented formatting-language list has 25 languages: Arabic, Czech,
Danish, Dutch, English, Filipino, French, German, Hindi, Indonesian, Italian,
Japanese, Korean, Macedonian, Malay, Persian, Polish, Portuguese, Romanian,
Russian, Spanish, Swedish, Thai, Turkish, and Vietnamese. The `language`
parameter controls formatting rather than whether the model will attempt the
transcription.

## Streaming protocol and latency controls

The WebSocket is configured entirely through query parameters. There is no
session setup message. The server first sends `transcript.created`; clients
must wait for it before sending audio. The client then sends real-time-paced
binary frames, with xAI suggesting 100 ms chunks.

Streaming accepts PCM16 little-endian, G.711 mu-law, G.711 A-law, or raw Opus.
Opus requires exactly one packet per WebSocket frame, is mono-only, and ignores
the sample-rate parameter. xAI estimates about 4 KB/s for Opus versus 48 KB/s
for PCM16 at 24 kHz. Ogg-Opus and WebM containers belong on the REST endpoint,
not in the streaming socket.

With `interim_results=true`, the server emits mutable partial transcripts
about every 500 ms. A `transcript.partial` event uses two booleans to distinguish
three states:

| `is_final` | `speech_final` | Meaning |
| --- | --- | --- |
| `false` | `false` | Interim text that may change |
| `true` | `false` | Locked chunk, normally about three seconds of speech |
| `true` | `true` | Complete utterance after end-of-speech detection |

`endpointing` sets the silence wait before an utterance-final event. It
defaults to 400 ms and accepts 0 through 5,000 ms. Smart Turn can instead
predict whether a silence is a genuine end of thought. It takes a confidence
threshold and an optional 1-to-5,000 ms fallback timeout. For push-to-talk,
the client can send `{"type":"finalize"}` when the button is released and
keep the session open. Sending `{"type":"audio.done"}` flushes remaining
audio, produces `transcript.done`, and closes the connection.

The streaming `vad_threshold` default is 0.08, unlike the REST default of 0.5.
That difference should be pinned explicitly in a benchmark because it can
change what quiet speech reaches transcription.

## OpenRouter status

OpenRouter's live catalog must be queried with
`?output_modalities=transcription`; STT models are omitted from its unfiltered
model response. On September 18 it returned one xAI transcription model:

- public ID `x-ai/grok-stt-1.0`
- canonical slug `x-ai/grok-stt-20260723`
- Audio to Transcription
- $0.10 per audio hour
- no 2.0 entry

That route is a useful non-streaming 1.0 control. OpenRouter accepts either
base64 JSON at `POST /api/v1/audio/transcriptions` or an OpenAI-style multipart
upload. Pointing an OpenAI SDK at `https://openrouter.ai/api/v1` works for the
multipart form. Its platform limits differ from direct xAI: multipart uploads
are capped at 25 MB, audio URLs are unsupported, and upstream processing has
an approximately 60-second timeout. The common documented formats are WAV,
MP3, FLAC, M4A, OGG, WebM, and AAC, with provider-specific variation.

OpenRouter does not document a live incremental STT endpoint. Its transcription
call returns one JSON response. Its "streaming" language around audio should
not be confused with xAI's `wss://api.x.ai/v1/stt` protocol.

## Benchmark plan

Run two gates rather than making streaming a prerequisite.

### Gate 1: direct REST, no product architecture change

Use the existing corpus and production audio encoding. Add direct xAI calls
for pinned 2.0 and, if useful, pinned 1.0. Compare them with the current
OpenRouter baseline. Use the same files and interleave request order.

Record WER, exact-match rate, preferred-name errors, punctuation, numbers,
correction preservation, filler handling, request median and p90, failures,
and billed cost. Test `format=false` and the production language with
`format=true`, because text normalization can affect apparent word accuracy.
Keep keyterms identical where the providers allow it.

### Gate 2: streaming prototype

Only proceed if 2.0 passes the quality gate or if the latency opportunity is
valuable enough to test independently. Measure:

- speech onset to first mutable partial
- speech onset to first locked chunk
- button release to `speech_final` when sending `finalize`
- button release to final pasted text
- partial-text revision count and visible instability
- reconnect, cancellation, and missing-final-event rates

Test 100 ms PCM frames first. Add Opus only if bandwidth or capture support
justifies its extra framing rules. For this push-to-talk product, explicit
`finalize` on release is the most relevant path; silence endpointing and Smart
Turn should be separate conditions rather than mixed into the first result.

The existing `Recorder` already captures mono PCM16 at 16 kHz and raises live
chunks from 40 ms input buffers. Its encoding matches xAI's streaming API.
The prototype can aggregate those callbacks into roughly 100 ms WebSocket
frames rather than replacing audio capture. The larger work is session
lifetime, backpressure, partial-result state, finalization, and reconnects.

## Unknowns that require measurement

xAI has not published a version-to-version WER table, real-time factor,
time-to-first-partial, finalization latency, supported-accent breakdown, or a
model-specific changelog beyond the 2.0 availability entry. The generic Voice
overview says the Voice APIs have sub-second latency, but it does not define
the metric or attribute a number to Transcribe 2.0. Do not use it as an
end-to-end latency forecast.

Artificial Analysis has an early independent non-streaming result. Its AA-WER
v2 leaderboard reports 2.3% WER and a 164x median speed factor for Grok Voice
Transcribe 2.0, compared with 4.0% and 238x for 1.0. On that same benchmark,
MAI-Transcribe-2 scores 2.0% and 325x. The benchmark uses roughly eight hours
across three datasets, while its speed trials use ten-minute audio, so neither
the ranking nor the throughput number predicts short-dictation performance in
this application.

The public price table is service-level rather than version-specific. It lists
one REST and one streaming STT rate, while the STT documentation lists both
model versions under those endpoints. That supports using the same published
rate for the two models today, but billed cost should still be captured from
real requests.

Calling xAI directly also changes the application's credential and privacy
story. It needs an xAI API key rather than the saved OpenRouter key. xAI says
it does not train on API inputs or outputs without explicit permission, but it
stores requests and responses for 30 days by default for abuse auditing. A
team-wide Zero Data Retention option is available. This should be disclosed in
settings before direct xAI support ships.

## Primary sources

- [xAI release notes](https://docs.x.ai/developers/release-notes)
- [xAI Speech to Text guide](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text)
- [xAI STT REST and WebSocket reference](https://docs.x.ai/developers/rest-api-reference/inference/speech-to-text)
- [xAI Speech to Text service page, pricing and limits](https://docs.x.ai/developers/models/speech-to-text)
- [xAI Grok Voice Transcribe 2.0 model page](https://docs.x.ai/developers/models/grok-voice-transcribe-2.0)
- [xAI API pricing](https://docs.x.ai/developers/pricing)
- [xAI API security, retention, and ZDR](https://docs.x.ai/developers/faq/security)
- [OpenRouter live transcription catalog](https://openrouter.ai/api/v1/models?output_modalities=transcription)
- [OpenRouter Grok STT 1.0 model page](https://openrouter.ai/x-ai/grok-stt-1.0)
- [OpenRouter transcription guide](https://openrouter.ai/blog/tutorials/transcription-on-openrouter/)
- [Artificial Analysis non-streaming STT leaderboard](https://artificialanalysis.ai/speech-to-text/non-streaming)
