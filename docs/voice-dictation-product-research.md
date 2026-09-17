# Voice dictation product research

Research date: 2026-09-15. Sources are first-party product pages, help documents, policies, and official repositories. Marketing accuracy claims are recorded as vendor claims, not independent findings.

## Short answer

The useful ideas are not more aggressive prose cleanup. Local Whisper already has the hard core of the product: system-wide capture, provider choice, dictionary hints, optional conservative cleanup, searchable local history, saved recordings, and performance evidence.

The strongest additions would make that core easier to teach, inspect, and adapt:

1. Learn proposed dictionary entries from small edits made after paste, with a review queue and clear provenance.
2. Add exact replacement aliases and spoken snippets alongside recognition hints.
3. Add per-app profiles for cleanup, tone, language, paste behavior, and optional context sources.
4. Turn History into a workbench: compare raw and cleaned text, rerun cleanup with another profile, show what context and settings were used, and offer explicit retention periods.
5. Add a separate selected-text voice action. Spoken instructions could rewrite the selection in place or return an answer without replacing it.
6. Let users define a few restrained cleanup styles or prompts instead of making one cleanup prompt cover every kind of writing.

This order borrows the best behavior from Wispr Flow and Typeless without copying their broad cloud-context collection. It also fits Local Whisper's local-history and bring-your-own-key model.

## What Wispr Flow does

### Context is much broader than the active application

Flow's context request can include the application, text before and after the cursor, selected text, visible screen text, a screenshot, open application names, conversation history, and IDE file or symbol names. It excludes standard password fields, numeric-only and other sensitive fields, browser address bars, banking apps, and Flow itself. Context is on by default on Mac and Windows. Windows support is narrower than Mac. Flow collects the context locally, then sends it with the cloud dictation request. [Wispr Flow context-awareness documentation](https://docs.wisprflow.ai/articles/4678293671-Context-Awareness)

The coding version is unusually specific. In Cursor, Windsurf, and VS Code, Flow can add function, class, variable, file, and symbol names from the active editor to the request, then format recognized variables as inline code. The context is collected fresh per dictation and is not cached between sessions. [Wispr Flow variable recognition](https://docs.wisprflow.ai/articles/8554805225-variable-recognition)

This suggests a safer Local Whisper design: context should be a set of independently enabled inputs, not one "context awareness" switch. Application identity, focused-field text, selected text, clipboard text, visible-window OCR, and IDE symbols have different privacy costs and failure modes.

### Vocabulary is learned, editable, and shared

Flow says it learns names, jargon, and technical terms over time. Its dictionary UI distinguishes auto-learned and imported entries, supports search, sorting, starring, bulk deletion, and team sharing. Dictionary terms apply to dictation and meeting notes. [Flow overview](https://docs.wisprflow.ai/articles/2772472373-what-is-flow) [Shared dictionary and snippets](https://docs.wisprflow.ai/articles/9639977157-view-shared-dictionary-words-and-snippets-in-the-admin-portal)

Flow also has snippets. A spoken trigger such as "my address" expands to a saved block of up to 4,000 characters. Personal snippets work on the free tier; teams can share them. Flow marks snippets it learned automatically and supports bulk import. The matching rules are described to users, including whole-word matching and personal entries taking priority over team entries. [Create and use snippets](https://docs.wisprflow.ai/articles/5784437944-create-and-use-snippets)

Local Whisper already sends preferred terms as transcription hints. The missing pieces are exact aliases, snippets, origin badges, enable switches, and a review path for suggested entries. Those pieces are deterministic and stay useful when Luna cleanup is off.

### Cleanup responds to the destination

Flow's Smart Formatting adjusts capitalization and spacing around the insertion point. It detects messaging apps and can omit a trailing period for short chat messages. Users can choose writing styles, and iOS stores a default per application category such as Personal, Work, Email, and Other. Backtrack handles spoken self-corrections. Desktop History can undo and redo the AI edit for one transcript. [Smart Formatting and Backtrack](https://docs.wisprflow.ai/articles/5373093536-how-do-i-use-smart-formatting-and-backtrack)

The lesson is narrower than "make the model context aware." Most of the value comes from a few predictable facts: whether the cursor is mid-sentence, whether the target is a chat app, and which style the user assigned to that app. These can be explicit and inspectable.

### Voice commands are a second mode

Paid desktop users can hold a separate shortcut and speak an instruction. Text-editing commands act on surrounding or selected text. Search commands can open Google, Perplexity, ChatGPT, or Claude with the spoken query and any selection appended. Command triggers use a constrained grammar and a distinct activation shortcut. [How to use Command Mode](https://docs.wisprflow.ai/articles/4816967992-how-to-use-command-mode)

Keeping commands separate from dictation is a good boundary. It reduces the risk that ordinary dictated prose gets executed as an instruction.

### History is local, but its controls are inconsistent

Flow states that transcript history is local to each device and does not sync. Desktop keeps a full history and supports copy/report, but not deletion of one item. iOS and Android allow per-item deletion; iOS can retry a failed transcription. Sign-out is the desktop mechanism for clearing all transcripts. [Flow overview](https://docs.wisprflow.ai/articles/2772472373-what-is-flow) [Delete transcripts and history](https://docs.wisprflow.ai/articles/4465314211-delete-transcripts-and-history-in-wispr-flow)

Flow offers local retention settings: normal storage, deletion after 24 hours, or no local storage. Its privacy and cloud-sync controls are separate. Transcription still happens in the cloud. Opting out of model improvement does not by itself prevent cloud history sync where that option exists. [Context-awareness documentation](https://docs.wisprflow.ai/articles/4678293671-Context-Awareness) [Model improvement and private cloud sync](https://docs.wisprflow.ai/articles/3842996553-privacy-mode-private-cloud-sync)

Local Whisper encrypts transcript text and timing data for the Windows account, but the current desktop build also saves original WAV bytes directly in its SQLite history. The UI exposes playback and download. It should add separate retention controls for text and audio, a "never save" option for each, and either protect saved audio at rest or state plainly that recordings are not encrypted.

### Small workflow ideas

Flow exposes separate bindings for push-to-talk, hands-free dictation, cancel, paste last transcript, copy last transcript, Command Mode, and Scratchpad. It accepts mouse buttons and can optionally interpret "press enter" at the end of a dictation, with a first-use confirmation. [Supported shortcuts](https://docs.wisprflow.ai/articles/2612050838-supported-unsupported-keyboard-hotkey-shortcuts)

Its Scratchpad is a lightweight note editor with search and pinning. iOS notes can start from the Lock Screen, Control Center, Siri, Action Button, or Spotlight and later open on Mac. [Using Notes on iOS](https://docs.wisprflow.ai/articles/3529886556-using-notes-in-wispr-flow-for-ios) [Pinning notes](https://docs.wisprflow.ai/articles/9879490397-pinning-notes-in-the-notes-hub-and-scratchpad-sidebar)

These are useful, but a Scratchpad would pull Local Whisper toward a note-taking product. Paste/copy-last bindings and a guarded auto-send option are much closer to its current job.

### Pricing and product boundary

Flow Free currently advertises 2,000 words per week on desktop and 1,000 on iPhone; Android is shown as unlimited. Pro is $15 per user monthly or $12 billed annually and removes the word cap. Paid team tiers add shared dictionary/snippets and administration. [Wispr Flow pricing](https://wisprflow.ai/pricing)

Flow now also bundles meeting capture, speaker identification, meeting Q&A, and MCP access. That is evidence of a broader product direction, not a strong reason to add meetings to Local Whisper. The dictation improvements above have better fit.

## What Typeless does

### Its main differentiator is intent-aware rewriting

Typeless removes fillers and repetitions, recognizes a correction made mid-sentence, formats lists and steps, and changes tone based on the active app. It runs across macOS, Windows, iOS, and Android and advertises automatic detection of more than 100 languages. [Typeless Dictate guide](https://www.typeless.com/help/quickstart/dictate) [Typeless Windows feature guide](https://www.typeless.com/help/release-notes/windows/introducing-typeless-windows-app-beta)

This is more interventionist than Local Whisper's accepted cleanup prompt. The good part to copy is recognition of explicit corrections and spoken structure. Inventing details or freely optimizing phrasing would conflict with the project's current evidence, which favored conservative cleanup.

### Personalization is abstract and visible

Typeless says it learns preferences such as formal versus casual and concise versus detailed without retaining the specific message content. Users can see a personalization progress report and disable the feature. [Typeless personalization](https://www.typeless.com/help/quickstart/personalization)

That suggests a transparent alternative to a hidden style model. Local Whisper could keep a small local profile of user-approved preferences and show exactly what it believes, for example "Slack: lowercase, no trailing period" or "Email: keep greetings, medium detail." Every learned preference should be editable, resettable, and scoped by application.

### It learns dictionary terms from corrections

Typeless has manual and auto-added dictionary sections. When a user corrects a dictated word, Typeless says it learns the preferred spelling and adds it as an auto-added entry. Users can import CSV files and search, edit, or delete terms. [Typeless History and Dictionary](https://www.typeless.com/help/quickstart/history-and-dictionary)

This is the most valuable feature to borrow. Local Whisper should not silently accept arbitrary post-paste edits. It can watch the known target briefly, detect a small replacement, and offer a candidate such as `Roghage` to `Raikage` for confirmation. The existing [correction-learning research](correction-learning-research.md) describes the Windows UI Automation constraints and password-field exclusions.

### History retains enough material to recover from failure

Typeless History can filter dictations and assistant requests, copy text, send feedback, retry a failed request with the same audio, download or share audio, delete one item or all items, and choose retention of forever, one year, one month, one week, 24 hours, or never. Its dictionary and history guide still describes history as device-only. A newer release adds optional Pro cloud sync, and its data-controls page says disabling sync deletes cloud history text. [Typeless History and Dictionary](https://www.typeless.com/help/quickstart/history-and-dictionary) [Typeless data controls](https://www.typeless.com/data-controls) [Typeless cloud-sync release](https://www.typeless.com/help/release-notes/ios/keep-your-history-synced)

Same-audio retry fits the current implementation because Local Whisper already stores WAV recordings. It should be paired with a visible paid-request confirmation and separate audio retention controls. Rerunning Luna cleanup from the stored raw transcript is cheaper and should remain available even when audio storage is disabled.

### Voice editing, questions, and translation have their own shortcuts

Typeless can act on selected editable or read-only text through a separate "Ask anything" shortcut. Rewrite requests replace selected text. Answers and explanations leave it unchanged and appear separately. It also opens supported search sites with a query already entered. [Typeless Ask anything](https://www.typeless.com/ask-anything)

Translation is also a separate mode and shortcut. Users preselect and order target languages, then switch the destination language when dictating. [Typeless Translate guide](https://www.typeless.com/help/quickstart/translate)

A selected-text rewrite command fits Local Whisper better than a general web assistant. Translation is also a contained feature because it has an unambiguous output language and can reuse the cleanup request path.

### Privacy means cloud inference with short retention, not local inference

Typeless says transcription happens in its cloud. It sends audio, application identity, and relevant application text for contextual processing, then discards audio and context after returning the result. It says neither it nor third-party AI providers train on dictation data. History remains local unless the user enables optional sync. [Typeless data controls](https://www.typeless.com/data-controls)

This wording matters. "On-device history" is not "on-device transcription." Local Whisper should keep the same distinction whenever it describes local storage and OpenRouter processing.

### Pricing

Typeless Free currently includes 8,000 words per week with standard accuracy and access. Pro costs $30 monthly or $12 per member per month when billed annually. It adds unlimited words, enhanced accuracy, priority capacity, optional cloud sync, and team management. [Typeless pricing](https://www.typeless.com/pricing)

## Other products worth borrowing from

### Superwhisper: modes and an inspectable processing record

Superwhisper makes transcription and language-model processing independent choices inside a Mode. A mode can choose local or cloud speech recognition, optional AI processing, language, translation, context, automatic application or website activation, audio muting, system-audio capture, and speaker identification. Users can build custom modes rather than accepting one universal cleanup behavior. [Superwhisper Modes](https://superwhisper.com/docs/modes/modes)

Its History is the strongest reference here. Users can search original dictation, reprocess saved audio with the currently active mode, compare the original voice transcript with the AI result, inspect recording and model metadata, and see the exact prompt and context sent to the AI. [Superwhisper History](https://superwhisper.com/docs/get-started/interface-history)

Superwhisper also exposes practical insertion controls: paste automatically, restore the previous clipboard, simulate keystrokes for incompatible targets, and hold Shift to auto-send. [Superwhisper advanced settings](https://superwhisper.com/docs/get-started/settings-advanced)

For privacy, it allows local or cloud speech recognition and optional local or cloud post-processing. A fully local configuration sends neither audio nor text away. Its history, vocabulary, and replacements are stored locally. [Superwhisper sensitive-data guide](https://superwhisper.com/docs/security/sensitive-data)

The feature to copy is the processing receipt. For every Local Whisper history item, show the raw transcript, final text, provider/model, dictionary snapshot or selected relevant terms, cleanup prompt/profile, timing, and which context inputs were included. Do not reveal secrets or dump unrelated screen text by default.

### VoiceInk: composable profiles and local automation

VoiceInk Modes combine transcription model, real-time behavior, language, paragraph formatting, enhancement provider/model/prompt, selected-text or clipboard or screen context, output behavior, auto-send, and a shortcut. Modes can activate by application, website, a spoken trigger at the beginning or end, or a dedicated shortcut. [VoiceInk Modes](https://tryvoiceink.com/docs/modes) [VoiceInk mode triggers](https://tryvoiceink.com/docs/mode-triggers)

Its context controls are granular. Selected text comes through macOS Accessibility, clipboard text is captured at recording start, and visible-window text comes from a screenshot processed locally with Apple's OCR. VoiceInk sends extracted text, not the screenshot, to the selected AI provider. Plain dictation modes do not send these context inputs. [VoiceInk context awareness](https://tryvoiceink.com/docs/context-awareness)

VoiceInk can pass final text to a local command on standard input rather than paste it. That supports journal appenders, search launchers, and other user-owned automation without building each integration into the dictation app. [VoiceInk mode settings](https://tryvoiceink.com/docs/mode-settings)

Its History searches both original and enhanced text, plays saved audio, shows model and prompt metadata, exports CSV, compares performance, and offers separate retention settings for text and audio. [VoiceInk transcription history](https://tryvoiceink.com/docs/transcription-history)

VoiceInk is local-first by default. It supports local Whisper, Parakeet, Apple Speech, Ollama, local command-line models, optional cloud providers with the user's key, and custom OpenAI-compatible endpoints. [VoiceInk model catalog](https://tryvoiceink.com/docs/ai-models) [VoiceInk privacy policy](https://tryvoiceink.com/privacy)

For Local Whisper, application profiles and explicit context toggles are worth borrowing. Running arbitrary local commands should wait until the app has stronger permission boundaries and clear command previews.

### Aqua Voice: developer vocabulary, API parity, and live send

Aqua focuses its speech model on human-computer interaction and technical vocabulary. Its desktop app uses screen context, supports a custom dictionary and custom writing instructions, and works in code editors, terminals, and ordinary text fields. [Aqua Voice product page](https://aquavoice.com/) [Aqua for Cursor](https://aquavoice.com/use-cases/cursor)

Aqua's public API is unusually revealing about its context contract. A dictation request can carry the app name, bundle identifier, up to 6,000 characters before and after the insertion point, and a focused-element description. The same request applies the user's dictionary, replacements, instructions, messaging preference, and learned preferences. [Aqua API reference](https://aquavoice.com/docs/api)

Its Realtime Mode shows words during speech and lets the user say "send it" to submit the result. [Aqua Realtime Mode](https://aquavoice.com/realtime)

Aqua is cloud-based and requires internet access. Starter includes 1,000 lifetime words. Pro is $8 per month billed annually, Max is $24 annually and adds real-time text plus "send it," and Team is $12 per user monthly on annual billing. [Aqua Windows and pricing](https://aquavoice.com/windows)

Local Whisper's optional pause transcription is already a step toward live feedback. A read-only partial preview would be useful before attempting live insertion, which has much harder cursor and correction semantics.

## What the local Wispr database reveals

I inspected `%APPDATA%/Wispr Flow/flow.sqlite` read-only on 2026-09-15. I queried schema, counts, null coverage, and aggregate values. I did not copy raw transcript text, audio, screenshots, URLs, or dictionary phrases into this note.

The database is more useful as a map of product mechanisms than as a source of private examples:

| Evidence in this installation | What it suggests | Limit |
| --- | --- | --- |
| `History` has 1,300 rows. Of these, 1,206 include `app`, `url`, `additionalContext`, and `personalizationStyleSettings`. The context objects consistently have slots for accessibility text, OCR text, dictionary context, textbox contents, user identity, and a conversation ID. Textbox context is non-empty in 1,156 rows. | Context is assembled as a structured packet with multiple sources. App identity and focused-field text appear to be routine inputs, not rare fallbacks. | A populated column proves collection on this device, not how much each source improved output. |
| 1,102 rows have both `editedText` and `userEditMetaData`. Among the 994 rows with correction counters, 230 report at least one corrected word. Newer rows also store edit distance and detailed reasons why post-paste observation ended. | Wispr watches the inserted region for a bounded period and measures what changed. The stop reasons show defensive range tracking, including focus or anchor loss, a new dictation, elapsed time, and large edits. | The metadata does not prove every observed change became a learned preference. An edit can change meaning rather than fix recognition. |
| The `Dictionary` has 33 active entries: 25 sourced from `user_edits`, 6 defaults, and 2 manual entries. The edit-sourced entries have 97 recorded uses. The table also tracks `lastUsed`, local and remote frequency, source, observed source, starred state, deletion, snippets, and replacements. | Automatic vocabulary learning is not just a marketing label here. Wispr preserves origin and usage so learned items can be ranked, explained, and managed. | The database exposes results, not the acceptance threshold or extraction algorithm. Local Whisper should still require confirmation. |
| Three active entries are snippets and four have replacement text. | Wispr models recognition terms, exact replacements, and snippets as related but distinct behaviors. | Local Whisper's current importer intentionally skips snippets and converts a replacement entry to only its final text, losing the spoken trigger and provenance. See [wispr-dictionary.cjs](../desktop/wispr-dictionary.cjs). |
| `History` stores raw, formatted, pasted, edited, server-finalized, default, fallback, and desired transcript variants, plus confidence and divergence fields. Only two rows in this installation used fallback level 1, and no fallback-ASR divergence values were populated. | The data model supports quality comparison, recovery, and model evaluation. | The local usage does not support making automatic dual-model transcription a priority. It would add cost for little observed need. |
| Tables exist for command routing, polishing, voice preferences, writing samples, notes, meetings, calendar events, todos, links, automations, chat, and transcript corrections. Most are empty here; `Meetings` has one row. | Wispr is expanding from dictation into editing and meeting workflows. The cleanest reusable idea is a separate command or selected-text mode. | Empty tables and migration names show intended capabilities, not a mature or even enabled user experience. They are weak evidence for copying the broader suite. |

The clearest database-backed opportunity is the loop `paste -> observe a small edit -> propose a dictionary item -> record provenance and use count`. Local Whisper already has a careful Windows UI Automation design for this in [correction-learning-plan.md](correction-learning-plan.md). The database strengthens the case for implementing that plan, but not for making learning silent.

The inspection also found a Local Whisper documentation and storage issue. [history-store.cjs](../desktop/history-store.cjs) encrypts transcript text, raw text, and metrics with Electron `safeStorage`, but stores new audio bytes directly. The [README](../README.md) says "Audio is never saved," while the current Settings UI says original WAV recordings are stored. Those claims should be reconciled before adding more history features.

## Recommended backlog for Local Whisper

### Build next

| Feature | Concrete first version | Why it belongs now |
| --- | --- | --- |
| Reviewable correction learning | Observe only the known non-password target for a short post-paste window. Detect one small replacement and ask whether to add the corrected spelling or alias. Mark it `Suggested`, then `Confirmed` or `Rejected`. | It closes the quality loop without another model call. Typeless and Flow make learned vocabulary visible. |
| Exact aliases | Replace a user-approved literal phrase after cleanup. Longest match wins, no cascading, Unicode-aware boundaries. | Recognition hints are best effort. Aliases fix repeatable failures deterministically. |
| Spoken snippets | A trigger expands to static text. Require whole-word matching, preview the expansion, and keep snippets separate from vocabulary. | High value for links, signatures, addresses, and recurring prompts. No AI is needed. |
| History reprocessing | Rerun Luna cleanup from stored raw text, or retranscribe the saved WAV with another voice model. Show the expected paid request and a compact diff before replacing the saved result. | The required source material is already present. It turns saved history into a recovery tool. |
| Separate text/audio retention | Add Forever, 30 days, 7 days, 24 hours, and Never for transcripts and recordings independently. Protect retained audio at rest. Explain that counts fall when text history is deleted. | The app currently retains both indefinitely, while only text and metrics are encrypted. |
| Processing receipt | Show model, cleanup profile, timings, dictionary terms selected for the request, context-source names, and raw/final text. | Makes quality regressions debuggable and keeps context use honest. |

### Build after that

| Feature | Concrete first version | Guardrail |
| --- | --- | --- |
| Per-app profiles | Match the foreground executable. Choose cleanup mode, language, style, paste method, auto-send, and whether focused text may be read. | Start with app identity only. Do not capture screenshots as a side effect of profiles. |
| Selected-text voice edit | Separate shortcut. Read only an explicit selection, speak an instruction, preview the result, then replace in place. | Never reuse the normal dictation shortcut. Exclude passwords and unsupported controls. |
| User cleanup profiles | A few presets such as Verbatim, Clean, Chat, Email, and Prompt, plus an advanced editable instruction. | Keep the current conservative prompt as default. Show when a profile may paraphrase. |
| Translation mode | Separate shortcut and explicit target language. Return only translated text. | Preserve uncertainty, names, numbers, and formatting. Never infer the target language from context. |
| Guarded auto-send | Opt-in per application or while holding a modifier. Show a first-use confirmation. | Never enable globally or in terminals by default. |
| Partial preview | Display chunk results in the waveform UI without inserting them into the target until finalization. | Label partial text as provisional. Cancellation cannot retract audio already uploaded. |

### Keep experimental

Screen OCR, full conversation capture, IDE symbol harvesting, and arbitrary command execution all expand the privacy or security boundary. They may be worthwhile, but each needs its own permission, visible capture indicator, exclusions, retention policy, and history receipt.

A general voice assistant, web search launcher, meeting notetaker, and synced note system are weaker fits. They turn a focused dictation tool into a broad productivity suite and would slow work on the quality loop.

## A practical context model

The competitors suggest a useful layered design:

| Layer | Example data | Default | Purpose |
| --- | --- | --- | --- |
| Profile | Active executable and user-assigned style | On | Pick known settings without reading content. |
| Insertion | A small bounded window before and after the cursor | Off | Capitalization, spacing, names, and continuity. |
| Selection | Only text the user explicitly selected | Off, enabled for voice edit | Rewrite or answer about selected text. |
| Clipboard | Clipboard text captured at dictation start | Off | Reference a copied item intentionally. |
| Visual | Locally extracted visible-window text | Off | Recover names and technical terms outside the focused control. |
| IDE | Open file and symbol names | Off | Technical vocabulary and code formatting. |

Each history item should record which layers were used and their byte or character counts. It should not display retained context unless the user explicitly asks to inspect it. A global emergency switch should disable all content context while leaving application profiles usable.

## Product principle

The best competitors make dictation feel adaptive, but their strongest ideas are surprisingly concrete: learn a corrected spelling, expand a phrase, choose a profile from the active app, rerun a past result, or act on an explicit selection. Those actions are understandable and testable.

Local Whisper should prefer that kind of adaptation. Broad screen context and freer rewriting may look smarter in a demo, but they create harder privacy promises and make a wrong result difficult to explain.
