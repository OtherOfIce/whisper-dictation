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

The page feature-detects `document.modelContext`. When that experimental API is present, it exposes small read-only helpers for progress and the current review. Browsers without it use the normal UI.

## Validation

From `tools/transcript-reviewer`:

```powershell
node --check server.cjs
node --check public/app.js
node server.cjs
Invoke-WebRequest http://127.0.0.1:4177/api/data
```
