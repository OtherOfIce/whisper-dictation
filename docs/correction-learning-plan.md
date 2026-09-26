# Learning from corrections

Proposed, not implemented. This describes our design, not Wispr Flow's internals.

## Flow

1. Before paste, capture the focused editable UI Automation element and insertion position where supported. Our existing window handle is insufficient to distinguish fields in one window.
2. After paste, verify that the final text actually appeared and identify its range. The current paste callback confirms only that Ctrl+V was sent. If insertion or range identification is ambiguous, do not observe edits.
3. Observe that element briefly, initially up to 30 seconds. Use text-change notifications and debounced reads of the bounded dictated range, with small anchors where necessary. Work off the keyboard/audio thread. Stop on target loss, navigation, another dictation, expiry, or inability to track the range reliably.
4. Compare stable edited text with what we pasted, after Luna cleanup. Never compare against raw recognition text for learning, because that would misclassify our own cleanup as a user correction.
5. Extract small word or phrase substitutions locally. Discard ordinary appended typing, punctuation-only edits, deletion of the whole dictation, broad rewrites, and ambiguous span matches. Keep numbers/dates and other likely changes of intent out of automatic learning.
6. For a clear, small correction that passes these checks, save the preferred spelling to the vocabulary list immediately. A single ambiguous edit is not enough: skip it rather than guessing. Do not create an unconditional replacement rule from an observed edit.
7. Show a Windows notification for each newly saved term, for example: “Saved Raikage to your dictionary” with an “Undo” action. The correction is already applied; ignoring or dismissing the notification keeps it. Do not notify when the term was already present.
8. Undo removes only the entry created by that learning event, and only if the entry has not since been changed by the user. It must not delete a pre-existing term or a later manual edit. Keep the notification action tied to that exact entry, including when several corrections arrive close together. The Dictionary screen must also let the user remove learned terms if a notification was missed or Windows suppressed it.

## Small implementation

One native correction observer owns UI Automation subscriptions, range tracking, timeout, and disposal. It emits a candidate containing the transcript ID and short before/after phrases. After the native settings layer saves a qualifying new term, Electron shows a Windows notification with an Undo button and routes that button back to the saved entry. Electron already uses actionable Windows notifications for “Copy transcript”; use the same notification path for the live action. Account for notification activation after an app restart so a stale Undo action cannot remove an unrelated entry. No background model calls or keylogger are needed.

Keep transient text comparisons in memory. Persist only the short candidate and the minimal metadata needed to identify and undo its saved entry, with bounded retention and Windows-account encryption. Never inspect password fields or follow observation into another text field. Add a setting to disable automatic learning independently of dictation and dictionary use.

UI Automation support varies by editor. Start with supported plain text fields; skip unreliable or inaccessible controls. A manual “Add to dictionary” action in History is the fallback. Do not silently switch to screenshots or global keystroke reconstruction.

## Validation before shipping

First prototype verified insertion and range tracking in the user's common editors. Test typing, mouse edits, paste-over corrections, cursor movement, selected-text replacement, IME input, undo, sending a message, focus changes, and duplicate phrases. Verify that notification Undo removes the exact learned entry, including with rapid successive saves, app restart, and later manual dictionary edits. Measure false saves as well as successful detections. Observation must not extend stop-to-paste latency or block recording.

The user's future Wispr dictionary can test large-list recognition. It cannot by itself test correction detection; that needs original pasted text plus the subsequent edit and target-control behavior.
