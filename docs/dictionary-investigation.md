# Dictionary and vocabulary investigation

Date: 2026-09-12. Scope: the current Windows pipeline (`Transcriber` sends JSON
`input_audio` to OpenRouter's `/api/v1/audio/transcriptions`; optional Luna cleanup
then receives the raw text). No production code or paid transcription calls were
made for this note.

## What the providers document

Direct OpenAI's current `POST /audio/transcriptions` contract exposes both
`keywords` (words or phrases to guide transcription, explicitly supported by
`gpt-transcribe`) and `prompt` (free-form style/continuation context). It also
supports `languages` for `gpt-transcribe`; `prompt` should match the audio
language. These are hints, not a deterministic replacement mechanism. See the
[OpenAI create-transcription reference](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create#body-parameters).

OpenRouter's GPT Transcribe model page describes the model as supporting
“free-form context, keyword hints, and multiple language hints,” and currently
shows the OpenAI provider. See [OpenRouter GPT Transcribe](https://openrouter.ai/openai/gpt-transcribe).
However, OpenRouter's STT endpoint documentation lists only `language`,
`temperature`, `response_format`, and timestamps as normalized top-level fields.
It says provider-specific features such as vocabulary/keyword hints must be sent
under `provider.options`, using the serving provider's own field names; providers
may drop unsupported options without an error. Its OpenAI-style multipart note
explicitly says `prompt` is accepted but ignored. See [OpenRouter STT request
parameters and provider options](https://openrouter.ai/docs/guides/overview/multimodal/stt#request-parameters).

Therefore, for this app's OpenRouter JSON `input_audio` request:

* `prompt` or `keywords` at the top level is not documented as a reliable
  OpenRouter feature.
* A provider-scoped hint (for example, the serving provider's documented
  `keywords`/`prompt` field under `provider.options`) is plausible only after
  checking the endpoint/provider record and testing it. OpenRouter says options
  are provider-specific and may be silently dropped, so this remains an
  unverified integration choice until measured.
* Direct OpenAI and OpenRouter passthrough must be treated as separate contracts.
  A field supported by direct OpenAI is not automatically supported by the
  OpenRouter proxy.

## Practical dictionary strategy

Use two separate concepts:

1. **Exact post-transcription aliases (deterministic).** Maintain a small,
   user-owned map of exact phrases to preferred text, applied locally to the
   final text. This handles known recurring errors such as `Astro` → `Astra` or
   `Roghage` → `Raikage` when the user has explicitly declared those spellings.
   Match case and word boundaries, apply longest phrases first, and avoid fuzzy
   or global substring replacement. Keep replacements reviewable and reversible
   in the raw-text history.
2. **Recognition hints (probabilistic, optional).** If the request is later
   extended, pass a compact list of preferred terms as provider-specific
   vocabulary hints, or to direct OpenAI's `keywords` field where supported by
   `gpt-transcribe`. Keep the list short and domain-specific; hints can bias a
   transcript toward a term that was not actually spoken. Do not describe this
   as a dictionary or guaranteed correction.

The phrase `in Mortality` → `immortality` is context-dependent and should not be
an unconditional alias. It needs a phrase/context rule (or Luna's contextual
cleanup with explicit evidence), since replacing `Mortality` everywhere could
change a legitimate sentence. Likewise, unfamiliar names should not be guessed
by Luna solely because they appear in a preferred-terms list.

The local evaluations support this division: the compact Luna prompt preserved
`Astro` and could not infer `Astra`, `Roghage` → `Raikage`, or `in Mortality` →
`immortality`; it was intentionally instructed not to guess unfamiliar names.
See [Luna/Wispr investigation](luna-wispr-investigation.md), especially the
sample findings and exact prompt. The raw transcript and cleaned text are kept
separately by the existing evaluation artifacts, which makes a deterministic
final pass auditable.

## Recommendation for the parent implementation

Start with the exact local alias pass, enabled only for explicitly configured
aliases, and run it after Luna (or directly after transcription when cleanup is
off). Preserve `rawText` and the pre-alias text so the user can inspect what was
changed. Treat provider hints as a later opt-in experiment with a measurable
fixture; do not add a top-level `prompt` field to the current OpenRouter request
based only on the direct OpenAI contract.

Sources: [OpenAI transcription API](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create), [OpenRouter STT guide](https://openrouter.ai/docs/guides/overview/multimodal/stt), [OpenRouter GPT Transcribe model page](https://openrouter.ai/openai/gpt-transcribe), and the repository's [Luna investigation](luna-wispr-investigation.md).
