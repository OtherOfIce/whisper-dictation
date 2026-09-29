# Temporary Android recording diagnostics

Open Voice input → Recording diagnostics and enable Save recordings temporarily. This keeps the latest ten recordings, up to 50 MB, in app-private storage outside backups. Audio is not uploaded to Convex. Saving is off by default; turn it off and use Clear recordings when the investigation is finished.

Dictate a phrase that produces a bad transcript, then return to Recording diagnostics. Refresh the list and play the recording. Details shows the raw provider transcript and the result after optional cleanup. Export ZIP saves WAV files and matching JSON reports to a location you choose on the phone.

Each WAV is copied from the file passed to the transcription client before that client starts. The report contains the requested model, language, dictionary count, MAI race and cleanup settings, outcome, elapsed request time, and raw and final transcripts. It does not contain credentials, dictionary text, auth headers, or request bodies. A fallback may use another model; the report labels its model as requested rather than claiming which model succeeded.

Audio measurements include the WAV format, actual PCM duration, average and peak level in dBFS, percentage of samples near full scale, and percentage of 20 ms frames quieter than -50 dBFS. Quiet frames include pauses; the percentage alone does not establish a recording fault. The capture report also records the microphone source, reported sample rate and channel count, buffer size, wall-clock capture duration, input device when available, and whether the writer finished normally. A warning identifies a WAV header that disagrees with the file length.

## Pull recordings over ADB

With the development APK and an authorized phone connected:

```powershell
.\tools\pull-android-recordings.ps1
```

The script copies the private WAV and JSON files into an ignored, timestamped folder under `artifacts/android-recordings/`. It preserves binary audio bytes and does not print transcript contents. Pass `-Serial` if more than one phone is connected. This route requires a debuggable APK; the in-app export works without ADB.

## Investigation

The current problem is poor transcription on the phone. No saved bad recording has established its cause yet. These captures let us listen for distortion or missing speech, compare file duration with capture duration, and replay the exact audio through another model. The microphone source and encoding are unchanged so the first comparison observes the current behavior.

Tests cover known silent and clipped PCM samples, header mismatches, exact-byte retention and ZIP export, retention limits, disabled logging, and a log-write failure that must not prevent transcription. Diagnostics can keep completed recordings even if the request fails or is cancelled after capture. Cancelled microphone recordings that never reach transcription are discarded.
