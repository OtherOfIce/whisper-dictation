# Dictionary sync

Windows and Android can sync their preferred transcription terms through a dedicated Convex project. Audio and transcript history stay local. Sync is optional; the dictionary works without a connection.

This workspace uses the [local-whisper Convex project](https://dashboard.convex.dev/t/liam-bradshaw/local-whisper), with production endpoint `https://rare-canary-989.convex.site`. The desktop connection is already saved. The private `artifacts/dictionary-sync-connection.json` file holds the URL and key to enter on Android; it is ignored by Git. The setup instructions below are for creating another deployment.

## Set up Convex

The CLI is installed in `sync/`. From a PowerShell terminal at the repository root:

```powershell
cd sync
npx convex dev --once --configure new
```

Sign into your Convex account when prompted and create a project for Local Whisper. Choose a cloud deployment. The CLI writes deployment configuration to the ignored `sync/.env.local` file.

For a production deployment:

```powershell
npx convex deploy
$dictionarySyncKey = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
npx convex env set --prod DICTIONARY_SYNC_KEY $dictionarySyncKey
```

Copy the production HTTP Actions URL from the Convex dashboard. It ends in `.convex.site`, rather than `.convex.cloud`. [Convex HTTP actions](https://docs.convex.dev/functions/http-actions) describes these URLs.

Enter that URL and the generated key in Windows Settings → Dictionary sync and Android Voice input → Dictionary sync. On Windows, click Save sync connection. On Android, click Connect. Use the same deployment and key on both devices. Keep the key private; it grants read and write access to this dictionary. It is a separate secret from a Convex deploy key.

You can use the development deployment instead by omitting `--prod` from the environment command and choosing its HTTP Actions URL. Set the key separately on each deployment you use.

The key remains in `$dictionarySyncKey` in your terminal session so you can paste it into both apps. Store it in your password manager before closing the terminal. The apps keep encrypted local copies. Empty key fields retain the saved key when editing the connection. Disconnect stops syncing and keeps local terms.

## Sync behavior

- Connecting merges existing local terms into the cloud dictionary. It does not replace the cloud list with an empty local dictionary.
- Windows syncs on launch, after saving, importing or learning terms, and every minute while idle.
- Android syncs while Voice input settings or the keyboard's voice manager is open, every minute, and after saving terms. It does not run a background service when the keyboard is closed.
- Both apps retain saved edits offline and retry them. The local dictionary is the one used for transcription. Terms are snapshotted for recordings as before.
- Each request sends additions and removals relative to the last successful sync. Convex merges the changes in one database transaction. Unrelated edits survive; for the same term, the last applied change wins. Case changes count as edits. Reordering alone does not sync.
- Incoming changes merge with edits made during the request. Unsaved editor changes remain drafts. Only saved terms are uploaded.
- All dictionaries keep the existing limits of 1,000 terms, 120 characters per term, and 12,000 characters total. Grok's smaller recognition limits still apply. A sync that exceeds the app limits fails and leaves local edits available.
- This backend holds one personal dictionary. It is intended for devices sharing one key, not separate users with individual accounts.

The cloud stores dictionary text. Windows sync settings and its last synced dictionary are encrypted with Electron safeStorage. Android stores the sync connection and last synced dictionary with Android Keystore, separately from the OpenRouter key and outside device backups. Android's existing preferred-terms preference remains its local dictionary.

## Verification

```powershell
cd desktop
npm test
npm run test:ui
cd ../sync
npm test
```

Build Android with `tools/build-android.ps1`. The `DictionaryChangesTest` Android tests check merge behavior and limits.

After connecting two devices, add a term on one, sync both, and check that it appears on the other. Remove it, sync both again, and check that it disappears. Repeat with independent edits on both devices while offline, then reconnect. A live cloud round trip requires the Convex deployment and its environment key to be configured.
