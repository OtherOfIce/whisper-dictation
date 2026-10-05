# MAI streaming gateway benchmark

This standalone tool tests `microsoft/mai-transcribe-2-streaming` through Vercel
AI Gateway. It does not change the app's providers, UI, settings or key storage.
It uses pinned AI SDK 7 packages and requires Node.js 24 or later.

## Setup and first test

From the repository root:

```powershell
cd tools/gateway-transcribe-eval
npm ci
npm test
npm run bench -- --source ../../artifacts/wispr-corpus/normal --max-samples 3 --dry-run
```

Put the gateway key in `tools/gateway-transcribe-eval/.env.local`:

```dotenv
AI_GATEWAY_API_KEY=your_key
```

Alternatively set `AI_GATEWAY_API_KEY` in the shell. The tool never uses the
app's saved OpenRouter key. `.env.local` and the default report directory are
gitignored. Run from this tool's directory so the env file and relative paths resolve.

Start with one file and one call:

```powershell
npm run bench -- --source ../../artifacts/wispr-corpus/normal --max-samples 1 --repeats 1 --show-partials
```

Then repeat the same corpus subset:

```powershell
npm run bench -- --source ../../artifacts/wispr-corpus/normal --max-samples 12 --repeats 3 --output ../../artifacts/gateway-mai-streaming.json
npm run bench -- --source ../../artifacts/wispr-corpus/normal --max-samples 12 --repeats 3 --mode batch --output ../../artifacts/gateway-mai-batch.json
```

Batch uses `microsoft/mai-transcribe-2` on the same gateway as a latency and
accuracy baseline. It sends a whole WAV in one call. Its request timing starts
when the recording is available. For a useful comparison, compare batch
`requestMs` with streaming `stopToResultMs`, then compare WER on matching files.
Run the conditions again in reversed order to check for changes in service load.
Existing OpenRouter comparisons can also use `tools/transcribe-eval`, but its
accepted-equivalence scoring differs from this tool's strict WER.

Use `--sample <WAV-stem>` to repeat a particular recording. `--help` lists all
options. The tool makes sequential calls, alternates sample order between
repeats, and does not retry failed calls. Ctrl+C aborts the active call and
saves its failure in the report. Exit codes are 0 for success, 1 for call
failures or interruption, and 2 for setup errors.

## Corpus and audio

The source directory must contain WAV/reference pairs. If any
`<stem>.reviewed.txt` exists, only WAVs with reviewed references are eligible.
Otherwise it uses `<stem>.txt`, which may contain automatically edited text
and should not be treated as verbatim ground truth. Discovery is not recursive.
The tool validates every selected file before making any paid call.

Audio must be signed 16-bit little-endian mono PCM WAV at 16 or 24 kHz. The
parser strips RIFF metadata and sends only PCM bytes to streaming. Unsupported
files fail with a conversion message rather than silently changing the audio.
For another recording format, convert into a separate corpus directory:

```powershell
ffmpeg -i input.wav -ac 1 -ar 16000 -c:a pcm_s16le converted/input.wav
```

Copy its matching reference to `converted/input.txt`. No audio resampling is
needed for the existing 16 kHz dictation recordings.

## Measurements

The private JSON report contains per-attempt transcripts, references, event
text and timestamps, errors, strict normalized WER, and p50/p95 summaries.
Case and punctuation are ignored. Spelling variants and spoken-number forms
remain different; `equivalence-policy.json` is not applied. Failed attempts
are counted separately and excluded from WER and latency percentiles.

- `firstTranscriptMs` measures the first nonempty delta, partial or final from
  the start of the SDK call. It includes connection and authentication setup.
- `firstFinalMs` measures the first final event; it can be null.
- `audioEndMs` records when replay has supplied all PCM and closes the input.
- `stopToResultMs` measures from that point until the completed transcript.
- `requestMs` measures the complete SDK call, including replay time.

The default replay supplies 40 ms frames on a real-time clock and waits for
the final frame's duration before closing. Stop measures input completion in
the SDK, not a wire acknowledgement. It approximates recording replay, not
microphone-to-paste latency in the app. `--replay burst` sends without pacing
and measures throughput; keep its results separate from real-time runs.

Each call times out after the audio duration plus 60 seconds by default.
`--timeout-seconds` overrides the total call deadline. Partials can change;
the report scores the SDK's authoritative completed text, avoiding duplicate
text from concatenated partials, deltas and finals. Warnings are recorded.

Cost is an audio-duration estimate, not billed usage. The streaming default
is $0.54/hour and the batch default is $0.10/hour. Override with
`--price-per-hour` when prices change, and check actual charges in Vercel.
Failed attempts may incur charges. Reports save after every call so earlier
results survive a later failure.

## Verification and limits

`npm test` exercises the installed Gateway SDK against a fake WebSocket,
including its authentication protocols, start/done messages, exact raw PCM
upload, revised partials, final text, premature close, server errors and
timeout cleanup. It also checks WAV validation, real-time pacing and scoring.
These tests require no key and make no network calls.

Live model accuracy, access and latency require a gateway key. Transcription
is in beta with gradual team rollout, so a valid key may lack access. Streaming
does not expose the batch model's clean/verbatim options in this experiment.
See [API research](../../docs/vercel-mai-streaming-research.md) for official
sources and the protocol details.

## Undocumented option probe

`probe-streaming-options.mjs` sends experimental Azure options directly in the
Gateway WebSocket start frame, bypassing local SDK option validation:

```powershell
node --env-file-if-exists=.env.local probe-streaming-options.mjs --audio ../../artifacts/wispr-corpus/normal/20260906T100433Z-0ee08f40.wav --variant combined
```

`combined` sends `phraseList.phrases` with `Hashirama` and `Raikage`, and
`transcribeStyle: 'clean'`. Other variants are `phrases`, `style`, and
`baseline`. Each invocation makes one paid streaming request and saves the
server events in the ignored artifacts directory.

The 2026-10-03 combined probe completed, but the server explicitly marked both
`providerOptions.azure.phraseList` and `providerOptions.azure.transcribeStyle`
as unsupported, with the message `This option requires the Azure Speech API.`
The transcript did not correctly recognize `Raikage`. Successful completion
therefore does not indicate that the gateway applied those options.

Use `--dictionary <JSON array file>` to replace the probe's example phrases.
Use `--style verbatim` with `--variant combined` to send the same style and
phrase-list fields as the batch vocabulary comparison. This bypasses SDK
validation and records whether the server accepts or ignores the options.

```powershell
node --env-file-if-exists=.env.local probe-streaming-options.mjs --audio ../../artifacts/gateway-vocabulary-check/recording.wav --dictionary ../../artifacts/gateway-vocabulary-check/dictionary.json --variant combined --style verbatim --output ../../artifacts/gateway-vocabulary-check/streaming-with-dictionary.json
```

## Single recording vocabulary comparison

`compare-vocabulary.mjs` makes three sequential requests using the same WAV:
streaming without hints, batch without hints, and batch with a supplied dictionary.
Both batch requests use `transcribeStyle: 'verbatim'`, so only the phrase list
changes between them. Supply the dictionary as a JSON array of strings.

```powershell
node --env-file-if-exists=.env.local compare-vocabulary.mjs --audio C:/path/recording.wav --dictionary C:/path/dictionary.json --output ../../artifacts/gateway-vocabulary-check
```

The private output folder contains a copy of the recording and `comparison.json`
with the dictionary, transcripts, warnings and timings. Each completed attempt
saves immediately. Optional `--reference C:/path/reference.txt` scores word error
rate against a confirmed transcript. Without it, the report leaves accuracy
unscored. Streaming request time includes real-time replay; batch request time
measures upload and processing, so those totals are not directly comparable.
