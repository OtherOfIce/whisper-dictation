# Retrospective spoken correction, 3 November 2026

The 12:24:43 desktop history record preserved the raw opening question and the correction, but its cleaned output dropped both. The raw text was:

> Do you think they were intending to launch with a new model release? Sorry, I meant to end with. I think that would have made a lot of sense, and I know there were some recent rumors about people seeing it. What can you find out about that?

Expected opening: "Do you think they were intending to end with a new model release?"

## Diagnosis

The shared prompt said to keep the new phrase in an old-phrase/correction/new-phrase pattern. It also said to preserve unaffected detail, but did not explicitly explain corrections referring back into a completed sentence or preserving the object after a corrected verb. This leaves competing interpretations of what counts as the replaced span.

The current source prompt failed all three live Luna Fast replays of the original wording and all three of a minimal version. Those replays ignored or retained the correction rather than reproducing the historical whole-question deletion. This establishes unreliable correction handling, not a deterministic reproduction of that exact deletion. History does not capture the full request or prompt version, so the precise historical model decision cannot be recovered.

CleanupService sends the prompt and dictation to the model. Its output checks reject truncation, blank output and repeated cursor context, but do not detect semantic deletions. Successful, fluent output therefore passes even if meaning is lost. The engine falls back to raw text on errors, which does not cover this case.

## Change

Clarify that corrections can refer back across sentence punctuation. Replace only the smallest affected phrase, preserving both the prefix and suffix. Include completed-question and corrected-date examples. When the target is ambiguous, retain the original and correction instead of deleting or guessing.

Add five live evaluation cases covering the original transcript, a minimal version, a corrected date with a retained time, and two unseen corrections. Add --case and --repeat for targeted repeat runs. Evaluation now exits nonzero on failed content checks as well as request errors.

## Validation

- Baseline: 6/6 original/minimal replays failed correction handling; 3/3 date controls passed.
- Initial updated prompt: 6/6 original/minimal replays applied the correction and retained the sentence. Two runs retained American spelling, a separate issue; the targeted check now focuses on preservation and correction rather than spelling.
- Full updated live evaluation: 20/20 cases, 73/73 checks passed.
- Local checks: 296 passed.
- Repeat the final five-case regression with: `dotnet run --project tools/cleanup-eval -- --tier fast --case retrospective --repeat 3`.

This is a prompt mitigation, not a guarantee of semantic equivalence. A blanket word-count rejection would also reject legitimate long false starts and corrections. Keep raw text and audio available for recovery. The prompt is embedded in the engine assembly and shared with Android; source edits require rebuilding and deploying the relevant application before taking effect.

Final targeted evaluation: all five cases passed across three repetitions, 15/15 runs and 78/78 checks, including both unseen correction examples.

Pre-push validation after restoring original UTF-8 punctuation: 22/22 live cases passed, 83/83 checks. Local checks passed again, 296/296.
