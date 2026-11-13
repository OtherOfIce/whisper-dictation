# Sync

Windows and Android can keep API keys, voice settings and a dictionary in step through a dedicated Convex project. Audio and transcript history stay local. Sync is optional; everything works without it.

This workspace uses the [local-whisper Convex project](https://dashboard.convex.dev/t/liam-bradshaw/local-whisper), with production endpoint `https://rare-canary-989.convex.site`. Both apps fill this in by default (`DEFAULT_SYNC_URL` in `desktop/renderer.js` and `WhisperScreen.kt`), so it only needs changing for another deployment.

## Linked devices

Sync connects devices to each other. There are no usernames or passwords to choose, and every device is equal.

- **Turn on sync** on any Windows desktop: Settings → Sync → **Turn on**. This creates an account named by a random id and shows a **recovery key** (six groups of five characters). Keep it in a password manager. It can be shown again on that device, and replaced, under Settings → Sync.
- **Link another device** from any device that already syncs: choose **Link a device** to show a 12-character code, then on the new device enter it under Settings → Sync (Windows) or Voice input → Account sync (Android). Codes work once and expire after 10 minutes.
- **Remove a device** from the list on any linked device. A removed device is signed out on its next sync. It keeps the keys it already had, so replace your provider keys if a lost device might be misused.
- **Lost every device?** On a new desktop open Settings → Sync → *Use a recovery key* and enter it. Everything synced comes back.
- A new device gets everything the device that linked it has: API keys, shared voice settings and the dictionary. Shortcut, microphone, lock mode, live chunks, learn from corrections and language always stay per device.

### Accounts made before linked devices

Accounts created with an email address and passphrase keep working. Sign in under Settings → Sync → *Use a recovery key, or an older email account*. The passphrase acts as that account's recovery key; it cannot be replaced from the new interface. Devices paired with per-device grants (for example a work laptop without API keys) keep those grants. Grants can no longer be edited, and new links always share everything.

### Adding a new key or shared setting

The engine decides what syncs. A new provider key needs one line in `SyncedKeys()` in `src/LocalWhisper/EngineApp.cs`; a new shared setting goes in `SyncState()` and `ApplySyncState()`. Nothing changes on the server. Devices that do not know an item yet leave it untouched, and pick it up the first time they do.

### How keys stay private

- A recovery key's first 10 characters name the account (`lw-<id>@sync.invalid` on the server); the other 20 (100 bits) are its secret. On the device the secret is stretched with PBKDF2-HMAC-SHA256 (600,000 iterations, salted with the account name) into two keys. One proves it to the server, which keeps only its SHA-256. The other seals the account keyring: a random 32-byte key per group.
- API keys are sealed on the device with AES-256-GCM using the keyring's secrets key, bound to their item name. The server only stores ciphertext. Shared settings and dictionary terms are stored in the clear on the server.
- A link code carries the keyring to the new device: both sides derive a lookup id and a key from the code, and the linking device seals the keyring with it. The server never sees the code or the keyring.
- Replacing the recovery key needs the current one, and re-wraps the same keyring, so linked devices keep working.
- Wrong recovery keys or passphrases are limited to 10 an hour per account; old attempts and expired codes are cleaned up hourly. Each account keeps up to 20 devices; adding one more removes the one used least recently.

## Server setup

The production deployment is already set up. Server version 2 (this repository) lets every linked device link and remove others; desktops talking to an older deployment can only do that from the device that created the account. Deploy with:

```powershell
cd sync
npx convex deploy
```

`ALLOWED_EMAILS` (optional) closes account creation to the listed email usernames. Recovery-key accounts are refused while it is set, so leave it unset to let new devices turn on sync.

`DICTIONARY_SYNC_KEY`, the shared key from before accounts, still syncs the dictionary for devices that were set up with it, but desktops no longer offer it. Remove it with `npx convex env remove --prod DICTIONARY_SYNC_KEY` once those devices use linked sync.

## Sync behavior

- A device joining an account merges its local dictionary terms into its list. For settings and keys the account wins on first contact, so a new device adopts what is already there; a key the account does not have yet is uploaded.
- After that, the side that changed wins. Clearing a key on one device clears it on every device given API keys.
- Windows syncs on launch, after saving settings or terms, when the window is focused, and every minute while idle. Android syncs every minute while Voice input settings or the keyboard's voice manager is open, and after saving. It does not run in the background when the keyboard is closed.
- Both apps keep saved edits offline and retry them.
- Dictionaries keep the limits of 1,000 terms, 120 characters per term and 12,000 characters total. Grok's smaller recognition limits still apply.

Windows keeps the account, keyring and sync bookkeeping encrypted with Electron safeStorage; the settings window never receives keys. Android keeps them in Keystore-backed storage, outside device backups.

## Verification

```powershell
cd desktop
npm test          # includes devices linking against the real server code (tests/item-sync.test.cjs)
npm run test:ui
cd ../sync
npm test
```

The crypto is checked against the same fixed vectors on Windows (`desktop/tests/vault.test.cjs`) and Android (`VaultCryptoTest`). `AccountItemsTest` pairs a simulated phone and syncs it against a fake server that enforces grants. Build Android with `tools/build-android.ps1`.
