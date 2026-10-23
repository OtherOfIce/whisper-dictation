# Account sync

Windows and Android can keep API keys, voice settings and a dictionary in step through a dedicated Convex project. Audio and transcript history stay local. Sync is optional; everything works without it.

This workspace uses the [local-whisper Convex project](https://dashboard.convex.dev/t/liam-bradshaw/local-whisper), with production endpoint `https://rare-canary-989.convex.site`. Both apps fill this in by default (`DEFAULT_SYNC_URL` in `desktop/renderer.js` and `WhisperScreen.kt`), so it only needs changing for another deployment.

## Accounts and devices

- **Create the account on a Windows desktop.** Open Settings → Account and sync, choose **Create account**, and enter a username and a passphrase of at least 12 characters. The username is an email address used only as a name; nothing is ever sent to it. That desktop becomes an admin device.
- **Add other devices from an admin desktop.** Choose **Add device**, name it, tick what it syncs, and pick its dictionary list. The desktop shows a 12-character code. On the new device choose **Pair with a code** (Windows) or enter it under Voice input → Account sync (Android). Codes work once and expire after 10 minutes.
- **Another admin desktop** (for example a replacement PC) chooses **Sign in** with the username and passphrase. This is also the way back in if the first desktop is lost.
- **Change or remove a device** from the device list on any admin desktop. A removed device is signed out on its next sync and keeps its local keys and settings. Changing the passphrase keeps paired devices and signs out other admin desktops.

Accounts are created and managed only on Windows; phones are always paired.

### What a device can be given

| Group | What it covers |
| --- | --- |
| API keys | Every key the app stores (OpenRouter, xAI, Vercel AI Gateway, and any added later). |
| Voice settings | Settings marked as shared: transcription model, cleanup mode, race two MAI requests. Shortcut, microphone, lock mode, live chunks, learn from corrections and language always stay per device. |
| Dictionary | One named list, for example Personal or Work, or none. Lists are created by naming them when adding or changing a device. |
| History | Shown but not available yet. |

The server enforces this: a device is never sent, and cannot write, a group it was not given. A device paired without API keys never receives the key that decrypts them, so turning keys on later means removing it and pairing it again.

Android uses the OpenRouter key and the three voice settings; models Android does not offer are left as they are, and its cleanup switch keeps the desktop's Luna Fast choice.

### Adding a new key or shared setting

The engine decides what syncs. A new provider key needs one line in `SyncedKeys()` in `src/LocalWhisper/EngineApp.cs`; a new shared setting goes in `SyncState()` and `ApplySyncState()`. Nothing changes on the server. Devices that do not know an item yet leave it untouched, and pick it up the first time they do.

### How keys stay private

- On the desktop, the passphrase is stretched with PBKDF2-HMAC-SHA256 (600,000 iterations, salted with the username) into two keys. One proves the passphrase to the server, which keeps only its SHA-256. The other seals the account keyring: a random 32-byte key per group.
- API keys are sealed on the device with AES-256-GCM using the keyring's secrets key, bound to their item name. The server only stores ciphertext.
- A pairing code carries the granted keys to the new device: both sides derive a lookup id and a key from the code, and the desktop seals the keys with it. The server never sees the code or the keys.
- **The passphrase cannot be recovered.** Admin desktops and paired devices keep working without it; it is only needed to sign in another admin desktop or change it.
- Wrong passphrases are limited to 10 an hour per username. Each account keeps up to 20 devices; adding one more removes the one used least recently.

### Server setup

The production deployment is already set up. For another deployment:

```powershell
cd sync
npx convex deploy
npx convex env set --prod ALLOWED_EMAILS you@example.com   # optional: limits who can create an account
```

With `ALLOWED_EMAILS` unset, anyone who knows the deployment URL can create an account. Set it to a comma-separated list of usernames to close sign-up; existing accounts can always sign in.

## Shared key (older setup)

Before accounts, devices shared one dictionary through a shared key (`DICTIONARY_SYNC_KEY`). It still works so existing devices are not cut off, but it only syncs the dictionary and is ignored while a device is signed in. Once every device uses the account, remove it with `npx convex env remove --prod DICTIONARY_SYNC_KEY`.

## Sync behavior

- A device joining an account merges its local dictionary terms into its list. For settings and keys the account wins on first contact, so a new device adopts what is already there; a key the account does not have yet is uploaded.
- After that, the side that changed wins. Clearing a key on one device clears it on every device given API keys.
- Moving a device to a different dictionary list replaces its local terms with that list. The old list stays on the server.
- Windows syncs on launch, after saving settings or terms, and every minute while idle. Android syncs every minute while Voice input settings or the keyboard's voice manager is open, and after saving. It does not run in the background when the keyboard is closed.
- Both apps keep saved edits offline and retry them.
- Dictionaries keep the limits of 1,000 terms, 120 characters per term and 12,000 characters total. Grok's smaller recognition limits still apply.

Windows keeps the account, keyring and sync bookkeeping encrypted with Electron safeStorage; the settings window never receives keys. Android keeps them in Keystore-backed storage, outside device backups.

## Verification

```powershell
cd desktop
npm test          # includes desktops pairing against the real server code (tests/item-sync.test.cjs)
npm run test:ui
cd ../sync
npm test
```

The crypto is checked against the same fixed vectors on Windows (`desktop/tests/vault.test.cjs`) and Android (`VaultCryptoTest`). `AccountItemsTest` pairs a simulated phone and syncs it against a fake server that enforces grants. Build Android with `tools/build-android.ps1`.
