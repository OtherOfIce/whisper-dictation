# Local transcript reviewer

This is a dependency-free, local-only browser tool for reviewing the 30-sample corpus in `artifacts/wispr-corpus/normal`.

## Launch

From the repository root:

```powershell
cd tools/transcript-reviewer
node server.cjs
```

Open <http://127.0.0.1:4177> in a browser. Set `TRANSCRIPT_REVIEWER_PORT` to use another local port. Stop the server with Ctrl+C.

The server binds to `127.0.0.1` and reads the WAV, Wispr, dictionary, and report files from this checkout. The browser makes no external requests. Review edits are stored in localStorage. Imported canonicals in `artifacts/wispr-corpus/normal/review.json` and the bundled earlier feedback seed samples that have no localStorage review. Use Export JSON for a restorable machine-readable file, or Export Markdown for a concise review handoff. Import JSON merges matching sample IDs into the current browser state.

Open a specific recording with `?sample=<sample-id>`. For example:

```text
http://127.0.0.1:4177/?sample=20260906T110730Z-ec5ae0d5
```

To review another exported corpus, set `TRANSCRIPT_REVIEWER_CORPUS` to its directory before starting the server. Candidate corpora may include a `.candidate.json` file beside each recording; the reviewer displays its category and insertion context.

```powershell
$env:TRANSCRIPT_REVIEWER_CORPUS = 'artifacts/wispr-corpus/luna-review'
node server.cjs
```

The page feature-detects `document.modelContext`. When that experimental API is present, it exposes small read-only helpers for progress and the current review. Browsers without it use the normal UI.

## Luna candidate review

Export a candidate set, review it with the corpus override above, and import the exported approvals:

```powershell
node tools/export-wispr-review-set.cjs --ids artifacts/luna-wispr-candidate-ids.json --output artifacts/wispr-corpus/luna-review --limit 10
node tools/import-transcript-review.cjs --review <exported-review.json> --corpus artifacts/wispr-corpus/luna-review
```

The transcription benchmark automatically uses only approved `.reviewed.txt` samples. The cleanup-only benchmark reads their saved Wispr ASR text directly:

```powershell
dotnet run --project tools/transcribe-eval -c Release -- --source artifacts/wispr-corpus/luna-review --output artifacts/transcribe-eval-luna-candidates-mai-clean.json --model microsoft/mai-transcribe-2 --style clean
dotnet run --project tools/wispr-cleanup-eval -c Release -- --input artifacts/transcribe-eval-luna-candidates-mai-clean.json --output artifacts/luna-candidates-mai-clean.json --tier standard
dotnet run --project tools/wispr-cleanup-eval -c Release -- --source artifacts/wispr-corpus/luna-review --output artifacts/luna-candidates-wispr-asr.json --tier standard
```

## Validation

From `tools/transcript-reviewer`:

```powershell
node --check server.cjs
node --check public/app.js
node server.cjs
Invoke-WebRequest http://127.0.0.1:4177/api/data
```
