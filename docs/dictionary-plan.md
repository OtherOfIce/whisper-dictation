# Personal dictionary plan

Status: the preferred-terms Settings editor and OpenRouter keyword hints are implemented. Paste one term or phrase per line and save; encrypted terms are snapshotted per recording and sent with each chunk. Empty lists omit provider hints. Automatic learning and local replacement rules remain unimplemented. The [automatic learning plan](correction-learning-plan.md) calls for saving qualifying terms by default with a Windows notification offering Undo. See [the research](dictionary-investigation.md) for provider support and sources.

## Update after the OpenRouter experiment

The [provider-hints test](openrouter-hints-test.md) succeeded on the selected recordings. `provider.options.openai.keywords` corrected Astra, Raikage, and immortality in both repeats; unhinted repeats retained the errors. The control transcript stayed unchanged, and reported costs matched. Latency remains inconclusive because both conditions suffered large delays later in the run.

This changed the implementation order: the preferred-terms dictionary now uses the tested transcription hints. It works without Luna or a second request. Explicit local aliases remain an optional follow-up for persistent errors. The original local-replacement design below is retained as a possible future approach.

## Recommendation

Start with explicit local replacements. Keep the dictionary separate from the cleanup switch, so predictable corrections still work when Luna is off. Add model hints as a second use of the same entries once the provider path is verified.

Distinguish two intentions:

- **Preferred term:** a name or spelling the model should recognize, such as `Raikage`. This is a hint, not permission to replace similar-looking words.
- **Always replace:** a user-approved mistake and its exact replacement, such as `Roghage` to `Raikage`. Apply this locally and deterministically.

Do not automatically create fuzzy replacements. For example, `in mortality` can be a valid phrase, and `Astro` may name a different product. Contextual guesses belong in an optional model step.

## First version

Add a Dictionary section in Settings. Each entry has a preferred spelling, optional “Always replace” phrases, and an enabled switch. Users can add, edit, delete, and search entries. Show a short preview before saving a replacement. No automatic learning from arbitrary text typed into other apps.

Store entries locally for the Windows account using the existing encrypted settings pattern. Dictionary edits affect future dictations; take a snapshot when recording begins. Keep empty dictionaries equivalent to current behavior.

The pipeline is:

```text
Audio → Transcribe → optional Luna cleanup → local dictionary replacements → paste
```

Apply replacements once to the completed text, after chunks have been joined. This supports phrases crossing a chunk boundary and avoids Luna subsequently undoing an explicit replacement. Preserve the untouched raw transcript in history as today. Count dictated words from that raw text.

Matching rules:

- Literal phrases only, with Unicode-aware word boundaries; never replace part of a longer word.
- Ignore case when matching and use the user's preferred spelling in the result.
- Match the longest applicable phrase first. Preserve surrounding punctuation.
- Build the result from matches in the original input; do not repeatedly replace newly inserted text.
- Reject conflicting aliases that map the same phrase to different outputs. Treat input as text, never as a regular expression.
- Define and test apostrophes, possessives, hyphens, and spaces explicitly before shipping.

Keep the matching behavior in one small native module, used both by the preview and the dictation pipeline. No general rules engine, plugins, or per-application profiles in this version.

## Model hints

Research finding: OpenRouter documents provider-specific vocabulary options under `provider.options`, keyed by the serving endpoint's tag. It does not guarantee every option is forwarded, and its OpenAI-compatible multipart `prompt` field is explicitly ignored. Verify the GPT Transcribe provider path with a small experiment before relying on recognition hints. See [OpenRouter's STT guide](https://openrouter.ai/docs/guides/overview/multimodal/stt#provider-specific-options).

If the transcription endpoint supports vocabulary hints, send preferred terms with the audio request. Recognition can then use the sound itself, which the text cleanup model cannot recover. A hint remains best effort.

When Luna cleanup is enabled, it can also receive a small glossary as data in its existing request. This costs extra input tokens but does not require another request. Dictionary content must not override cleanup instructions. Bound glossary size; for a large dictionary, select relevant entries rather than sending everything. Start with exact term/alias relevance and defer phonetic retrieval until it has evidence behind it.

Explicit local replacements remain the final authority regardless of whether a model uses the hints. Do not enable Luna automatically when the user adds a dictionary entry.

## Verification and rollout

Use the existing Wispr examples to test names, plus deliberately negative cases where similar words must remain unchanged. Cover substring collisions, punctuation, possessives, overlapping phrases, conflicting rules, non-cascading replacements, cross-chunk phrases, and cleanup disabled.

For model hints, compare the same audio with and without hints before choosing the default. Measure correct terms, accidental substitutions, latency, and actual request cost. The previous Wispr set contains few ambiguous names and is insufficient on its own to justify fuzzy matching.

Add a separate Dictionary corrections timing row to the existing performance view. Keep original/final text available for inspection. Local correction should add no network request; measure its processing time instead of assuming it is free.

Implement and evaluate local replacements first. Then add verified transcription hints; evaluate Luna glossary hints only where they improve a case the earlier steps miss.
