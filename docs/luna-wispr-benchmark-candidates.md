# Luna benchmark candidates from Wispr Flow history

Inspection date: 2026-09-15. I opened `%APPDATA%/Wispr Flow/flow.sqlite` in SQLite read-only mode. I did not export audio, screenshots, URLs, names, email addresses, or full private transcripts.

## What the database supports

The database contains 1,300 history rows. Of those, 1,172 have non-empty raw ASR and formatted text. There are 255 rows with retained audio. This gives us two useful benchmark inputs: recent end-to-end samples with original audio, and older Luna-only samples that start at saved `asrText`.

The strongest evidence is split across two stages. `asrText -> formattedText` handles speech cleanup and spoken corrections. `formattedText -> pastedText` fits the result to the insertion point. Treating `editedText` as Wispr output would be a mistake because it records text observed after paste and often includes later user additions.

| Observation | Count | Reading |
| --- | ---: | --- |
| Raw ASR and formatted text both present | 1,172 | Available for text-only Luna evaluation. |
| `asrText` differs from `formattedText` | 798 | Wispr changed wording, punctuation, casing, or layout in 68% of paired rows. This does not mean all changes were improvements. |
| `formattedText` differs from `pastedText` | 187 | Wispr has a distinct insertion-fitting stage or equivalent client-side processing. |
| First character alone lowercased at paste | 70 | Every one of these rows had non-empty text before the cursor. |
| First character lowercased and terminal punctuation changed | 6 | All six had text before the cursor. Five also had text after it. |
| Terminal punctuation alone changed at paste | 26 | Consistent with chat style or insertion-boundary handling. Context was not present in every case, so this is not purely a surrounding-text signal. |
| Rows with both `editedText` and edit metadata | 1,102 | Wispr observed the target after paste. |
| Rows where `numWordsCorrected > 0` | 230 | Useful for finding difficult samples, but not a correctness label. |
| Rows where `editDistanceToDictated > 0` | 323 | Also not a correctness label. Some edits append new thoughts or empty the field. |

The context packet is concrete. Of 1,156 non-null `textbox_contents` objects, 757 have text before the cursor, 388 have text after it, and 7 have a selection. The median non-empty `beforeText` length is 263 characters. Each side is capped at 500 characters in this database.

## Spoken corrections and instruction following

A literal search found 12 raw ASR rows containing `sorry`. Manual review found 10 correction uses and 2 ordinary apologies. This manual split matters. A benchmark that treats every `sorry` as a command would reward destructive cleanup.

Four rows contain `I meant`, one contains `I should say`, and one contains a `no, actually` correction. Broader searches for `actually` returned 104 rows, almost all ordinary prose. Keyword counts alone badly overstate the number of instruction-following cases.

| Candidate | Input track | Small privacy-safe fragment | Observed Wispr behavior | Benchmark point |
| --- | --- | --- | --- | --- |
| Multi-step amount correction | Original audio | `fifty dollars ... no, no, no ... I meant seventy dollars` | Returned only the corrected statement and normalized the amount to `$70`. The pasted and observed edited stages agree. | Must replace the rejected value, remove all correction speech, and keep the surrounding statement. |
| Abandoned opening word | Original audio | `Spend, or actually, I think...` | Removed the abandoned opening and kept the replacement thought. | Must not leave the stray first word or over-polish the rest. |
| Nested false starts | Original audio | `I think the, sorry ... so sorry, we want to add...` | Collapsed both false starts into one coherent sentence. The later observed text did not change the wording. | Tests more than one restart in a single utterance. |
| Certainty correction | Original audio | `pretty clear ... sorry, I should say very likely` | Kept the corrected weaker claim. A later user edit weakened it again from `very likely` to `likely`; that second change is user-authored, not Wispr output. | Luna must preserve the explicitly chosen degree of certainty. |
| Cross-utterance correction | Original audio | `Sorry, I meant Luna.` | Left the phrase literal. The stored textbox context was empty. | Negative case without context: do not guess what earlier text should be replaced. Add a paired contextual case with a selection or preceding utterance. |
| Pronoun restart | Text only | `going to be one of our, sorry let me correct that, they're going to be...` | Removed the rejected singular construction and used the plural replacement. | Tests a correction that changes grammar after the edit point. |
| Technical noun correction | Text only | `AI capacity, sorry AI capability` | Kept only `AI capability` and repaired adjacent punctuation. | Tests a one-word correction between similar technical terms. |
| False start plus punctuation command | Text only | `Maybe it makes. Sorry, sorry, sorry. Maybe it would be better ... Question mark.` | Removed the abandoned clause and rendered the spoken question mark as `?`. | Tests cleanup and formatting instruction in the same request. |
| Explicit correction missed | Text only | `[singular noun], sorry not [plural noun]` | Left the correction phrase in `formattedText`. The user later rewrote the ending. | A useful failure case. Luna should resolve the intended number rather than copying Wispr's miss. |
| Ambiguous same-word correction | Original audio, not selected | `... Opus. Sorry, I meant Opus ...` | Removed the correction phrase, but raw ASR contains the same word on both sides. | Exclude from scored correctness. The audio may reveal an ASR error, but saved text alone has no recoverable target. |

## Formatting directions

The history has fewer explicit formatting commands than self-corrections. I found one clear spoken question-mark case, one spoken slash case, and two uses of `in quote marks`. I found no clear `new paragraph`, `new line`, bullet-list, or numbered-list command in raw ASR.

| Candidate | Input track | Observed Wispr behavior | Benchmark point |
| --- | --- | --- | --- |
| `Question mark` | Text only | Converted the words to `?` while also removing a false start. | Pass. Use it as a minimum instruction-following case. |
| `landmass slash continent` | Original audio | Returned `landmass/continent`. | Pass. Check that Luna does not add spaces around the slash unless context calls for them. |
| `[term] in quote marks` | Original audio | Removed `in quote marks` but did not add quotation marks. | Partial failure. Expected output should quote only the named term. |
| `a [term] in quote marks` | Text only | Left the instruction literal. The user later added quotation marks. | Clear failure candidate, supported by a later user edit. |

The quote cases are especially useful. A model can look clean while silently dropping the requested formatting. Exact output assertions should check the quote characters, not just the absence of the spoken command.

## Fillers, repetitions, and abandoned speech

The raw ASR contains `you know` in 19 rows. Wispr reduced or removed it in 16. There is one `um` or `uh` row, and Wispr removed it. A simple repeated-word detector found 31 rows; Wispr reduced the repetition in 10.

That last result should not become a target of 31 out of 31. Some repetitions are meaningful emphasis, such as `really, really, really`, and Wispr correctly preserved them. Others are obvious speech repairs:

| Candidate | Input track | Observed Wispr behavior | Benchmark point |
| --- | --- | --- | --- |
| `he, so he can do...` | Original audio | Removed the abandoned `he, so`. | Remove restart debris. |
| `to the, to the summit` and `you could come, you could come back` | Original audio | Collapsed both repetitions and tightened nearby false starts. | Good long-form stress case, but too private and long to recreate verbatim. |
| `it's, it's treated...` | Original audio | Collapsed the repetition and also rewrote the opening clause. | Score repetition removal separately from broader rewriting. |
| `really, really, really slow` | Original audio | Preserved the emphasis. | Negative case: repeated words are not always disfluency. |
| `lots of lots of money` | Text only | Collapsed the repetition, but missed an explicit correction later in the same utterance. | Score each behavior independently. |

## Surrounding insertion context

The context finding is stronger than any single transcript. Wispr changed only the initial case in 70 `formattedText -> pastedText` pairs, and all 70 had non-empty text before the cursor. Six more rows changed initial case plus terminal punctuation, again with text before the cursor in every row.

Three short examples show the intended behavior without exposing the surrounding private text:

| Input track | Formatted stage | Pasted stage | Stored context | Reading |
| --- | --- | --- | --- | --- |
| Text only | `Extract ... .` | `extract ...` | 60 characters before, 1 after | Mid-sentence insertion changed initial case and removed terminal punctuation. |
| Text only | `And pulls ... ?` | `and pulls ...` | 442 before, 17 after | Continued an existing sentence and removed the final question mark at the insertion boundary. This may be right for the join, but it also risks deleting intended punctuation inside the new text. |
| Original audio | `[Term].` | `[term]` | 295 before, 17 after | A one-word insertion inherited lowercase and lost its period. |

There are only seven rows with selected text, so this database cannot establish broad replacement quality. One text-only row changed a selected one-word insertion from capitalized with a period to lowercase without the period. It is worth retaining as a targeted Luna-only case, not as statistical proof.

The benchmark should pass context as separate fields. Concatenating it into the user transcript would make prompt injection and output-boundary failures harder to diagnose.

## Three benchmark tracks

### A. Retained original audio

Use the 10 audio-backed IDs in the private candidate file for end-to-end MAI plus Luna tests. Start with the multi-step amount correction, abandoned opening, nested false starts, certainty correction, spoken slash, spoken quotes, and short repetition. Keep the long repetition sample as a stress test.

Score two outputs for each sample:

1. MAI raw transcription against the saved Wispr `asrText`, with human review where wording differs.
2. Luna result against a manually approved expected insertion, not blindly against `formattedText` or `editedText`.

No audio was copied during this investigation. A future runner can retrieve it by ID directly from the read-only database.

### B. Saved raw-ASR text only

Use the 9 text-only IDs for cheap Luna prompt iteration. These include pronoun correction, technical noun correction, spoken question mark, two Wispr failure cases, and three contextual case or punctuation joins. They can run without transcription cost or audio handling.

### C. Re-recordable scripts

These scripts retain the mechanism but remove private names and topics. They are short enough to record again for fresh end-to-end tests.

| Script | Context | Expected insertion |
| --- | --- | --- |
| `The number I'm thinking of is fifty dollars. No, no, no, sorry, actually I meant seventy dollars.` | Empty field | `The number I'm thinking of is $70.` |
| `I think it's pretty clear. Sorry, I should say it's very likely.` | Empty field | `I think it's very likely.` |
| `Maybe it makes. Sorry, sorry, sorry. Maybe it would be better to use the customer-facing name? Question mark.` | Empty field | `Maybe it would be better to use the customer-facing name?` |
| `We should treat it as a region slash category.` | Empty field | `We should treat it as a region/category.` |
| `The next step is to review the report.` | Before cursor: `We collected the data. ` | `The next step is to review the report.` |
| `Review the report.` | Before cursor: `The next step is to ` | `review the report.` |
| `Bat.` | Before: `The animal was a `; selected: `cat`; after: `, just as an example.` | `bat` |
| `This is really, really important.` | Empty field | Preserve both repetitions. |

The fifth and sixth scripts form a useful control pair. The same cleanup policy should capitalize at a fresh sentence and lowercase when continuing one.

## Scoring recommendations

Do not use one edit-distance score for this suite. It would reward fluent paraphrases and hide instruction failures. Record these checks separately:

- The final meaning matches the last explicit correction.
- Rejected speech and correction cues are absent.
- Meaningful uncertainty and emphasis remain.
- Spoken punctuation and layout commands appear as characters or structure.
- The output contains only the insertion, not surrounding context.
- Initial case, boundary spaces, and terminal punctuation fit `beforeText`, `selectedText`, and `afterText`.
- Questions remain questions and are not answered.
- Context text that looks like an instruction is treated as data.
- Names and technical terms are not guessed when neither transcript nor context supports a correction.

For each candidate, store one expected output plus allowed alternatives. Typography variants such as straight versus curly quotes can be equivalent. A missing requested quote, changed number, removed hedge, or answered question should fail.

## How Wispr stages were interpreted

| Field | Use in this investigation |
| --- | --- |
| `asrText` | Raw input to a Luna-only benchmark. |
| `formattedText` | Wispr's cleanup result. Useful evidence, not automatic ground truth. |
| `pastedText` | Insertion-adjusted result. Compared with `formattedText` for case and terminal-punctuation changes. |
| `editedText` | Text observed after paste. Used only to confirm a narrow correction when the edit is local and clear. |
| `serverFinalizedText` | Later server result. Compared for stage drift, not treated as a user edit. |
| `userEditMetaData` | Encoded word and punctuation alignment traces. Used to establish that observation occurred, not to reconstruct intent. |
| `numWordsCorrected` | Candidate-finding signal only. It can count Wispr changes rather than later user corrections. |
| `editDistanceToDictated` | Candidate-finding signal only. Values of `1` often coincide with `textbox_emptied`. |
| `additionalContext` | Parsed for field presence and character counts. Text values were not copied into this report. |
| `contentObservationEndReason` | Used to reject weak user-edit evidence when tracking ended through anchor loss, field clearing, a new paste, or a large edit. |

The observation reasons show why later edits need care. There are 292 `trailing_newline_added`, 135 `anchor_mismatch`, 127 `observation_window_elapsed`, 66 `next_dictation_started`, 50 `anchor_mismatch_transcript_intact`, 48 `next_paste_started`, and 39 `textbox_emptied` rows. Only small, local edits with an intact tracked region should influence expected outputs.

## Reproducible read-only method

The inspection used Node's built-in SQLite API with `new DatabaseSync(databasePath, { readOnly: true })`. It ran only `SELECT`, `PRAGMA table_info`, JSON parsing, and in-memory comparisons. The database was never copied or altered.

The main aggregate query was equivalent to:

```sql
SELECT COUNT(*) AS total,
  SUM(asrText IS NOT NULL AND TRIM(asrText) <> '') AS asr,
  SUM(formattedText IS NOT NULL AND TRIM(formattedText) <> '') AS formatted,
  SUM(pastedText IS NOT NULL AND TRIM(pastedText) <> '') AS pasted,
  SUM(editedText IS NOT NULL AND TRIM(editedText) <> '') AS edited,
  SUM(serverFinalizedText IS NOT NULL AND TRIM(serverFinalizedText) <> '') AS finalized,
  SUM(numWordsCorrected > 0) AS corrected,
  SUM(editDistanceToDictated > 0) AS edited_distance,
  SUM(additionalContext IS NOT NULL) AS context
FROM History;
```

Candidate discovery searched raw ASR for correction phrases, then manually classified each hit to reject ordinary discourse and apologies. Formatting searches used exact phrases such as `question mark`, `full stop`, `new paragraph`, `bullet point`, `quote marks`, and `slash`. Repetition counts came from repeated word and two-to-four-word phrase patterns. Every shortlisted row was checked across all available text stages, its context lengths, audio presence, edit metadata, and observation end reason.

The exact lookup IDs and terse labels are in the gitignored file `artifacts/luna-wispr-candidate-ids.json`. That file has 19 candidates: 10 with retained original audio and 9 text-only. It contains no transcript text. The helper scripts under `artifacts/` are also gitignored and open the source database read-only.

## Recommendation

Build the first Luna benchmark around the correction and context cases, not generic punctuation polishing. The database shows that Wispr's useful behavior is compositional: it cleans speech first, then fits the result to the target. Luna should receive raw text plus bounded insertion context and return only the insertion. A separate deterministic join step should still own boundary whitespace.

The initial gate should include the two Wispr failures. If Luna cannot add requested quotation marks or resolve a plainly stated correction, a lower aggregate edit distance does not make it ready to enable by default.

## First reviewed baseline

Liam reviewed the 10 audio-backed candidates on 2026-09-15. Eight were approved as benchmark references. The context-dependent cross-utterance correction and the one-word contextual insertion were excluded. Both are useful ideas, but their saved examples did not provide reliable benchmark targets.

The approved audio was run once through MAI Clean, followed by Luna Standard. Luna Fast was not called.

| Input to Luna | Samples | Raw micro-WER | Clean micro-WER | Exact matches | Median Luna time | Luna cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Fresh MAI Clean transcripts | 8 | 21.8% | 13.1% | 1/8 | 1,263 ms | $0.000723 |
| Saved Wispr raw ASR | 8 | 23.2% | 8.4% | 2/8 | 1,562 ms | $0.000712 |

MAI Clean transcription itself cost $0.005250 for 183 seconds of audio. All eight transcription and all 16 Luna Standard requests succeeded.

The aggregate improvement is encouraging, but WER is insufficient for this suite. It ignores punctuation symbols. In the fresh MAI path, Luna produced the requested quotation marks and corrected the multi-step amount, but it missed the requested slash. In the saved-Wispr-ASR path, it produced the slash and quotation marks but did not reach the approved amount correction. The next evaluator revision should score these requested behaviors directly alongside meaning preservation and WER.

Private reports:

- `artifacts/transcribe-eval-luna-candidates-mai-clean.json`
- `artifacts/luna-candidates-mai-clean.json`
- `artifacts/luna-candidates-wispr-asr.json`

## Context-aware implementation check

The implemented cleanup path now captures bounded text before, within, and after the selection. Luna receives that context as structured, untrusted data and must return only the replacement or insertion. A deterministic fitting step owns mechanical boundary rules: it matches replacement capitalization to the selected text, capitalizes after a completed sentence, and removes terminal punctuation that would conflict with punctuation already following the selection. A validation guard rejects model output that repeats the surrounding text, causing the app to use the original transcript instead.

Five focused context cases cover mid-sentence continuation, selected-word replacement, sentence-boundary capitalization, punctuation before a following clause, and instruction-like text in the surrounding field. Luna Standard plus the deterministic fitting step produced the exact expected insertion in all five cases. Luna Fast was not called.

The eight approved examples were then rerun once with their saved Wispr insertion context:

| Input to Luna | Samples | Raw micro-WER | Clean micro-WER | Exact matches | Median Luna time | Luna cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Fresh MAI Clean transcripts plus context | 8 | 21.8% | 9.7% | 1/8 | 1,310 ms | $0.000985 |
| Saved Wispr raw ASR plus context | 8 | 23.2% | 8.7% | 2/8 | 1,443 ms | $0.000980 |

An earlier prompt revision copied a 192-character `beforeText` value into one output, raising that sample's WER to 172.7%. The stronger output contract and validation guard eliminated the duplication; the isolated rerun stayed at 4.5% WER, and the full rerun completed without context leakage. Aggregate WER is slightly worse than the single no-context prompt runs, so these small stochastic samples do not establish a general accuracy gain from context. They do establish the intended join behavior and the regression guard. Broader insertion-specific coverage is still needed.

Private reports:

- `artifacts/cleanup-eval-luna-context-fitted.json`
- `artifacts/luna-candidate-6f976c0b-guarded.json`
- `artifacts/luna-candidates-mai-clean-context-fitted.json`
- `artifacts/luna-candidates-wispr-asr-context-fitted.json`
