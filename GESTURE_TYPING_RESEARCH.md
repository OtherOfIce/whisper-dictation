# Gesture typing research (HeliBoard 4.1 / Local Whisper fork)

## Finding

HeliBoard does not ship a gesture recognizer. Its README says glide typing works only with a closed-source native library; the library is omitted because there is no compatible open-source implementation. The documented sources are a GApps `swypelibs` package or the linked OpenBoard-compatible `jniLibs` directory. The expected artifact for a modern ARM phone is the `arm64-v8a/libjni_latinimegoogle.so` file. The app ultimately installs it under the private filename `libjni_latinime.so`.

Sources: [HeliBoard README, glide typing section](https://github.com/HeliBorg/HeliBoard/blob/main/README.md#features), [upstream library directory](https://github.com/erkserkserks/openboard/tree/46fdf2b550035ca69299ce312fa158e7ade36967/app/src/main/jniLibs).

## User installation flow

1. Obtain the library matching the device ABI (`arm64-v8a`, `armeabi-v7a`, `x86_64`, or `x86`) from a trusted source. For most current phones this is `arm64-v8a/libjni_latinimegoogle.so`; extracting the matching `swypelibs` file from GApps is the upstream-documented alternative.
2. In HeliBoard open **Settings → Advanced → Load gesture typing library**. The dialog displays the ABI the app wants.
3. Pick the downloaded `.so` file in the Android document picker. Restarting the keyboard/app is part of the load operation.
4. After restart, **Gesture typing** settings appear; enable gesture typing there. A main dictionary must also be available, and gesture typing is disabled in password fields.

The upstream loader copies the selected file into the app-private files directory as `libjni_latinime.so`, stores its SHA-256, makes the installed copy read-only, and exits so the process restarts and loads it. It accepts the known checksum for the selected ABI automatically; the confirmation path can explicitly accept an unknown checksum, but upstream warns that incompatible libraries may crash.

Source: [LoadGestureLibPreference.kt](https://github.com/HeliBorg/HeliBoard/blob/main/app/src/main/java/helium314/keyboard/settings/preferences/LoadGestureLibPreference.kt).

## Licensing and security

The gesture `.so` is closed source and is separate from HeliBoard. HeliBoard’s own code is GPL-3.0 (with AOSP portions under Apache-2.0); the upstream README specifically labels the gesture library closed source. Loading native code is a security boundary: the app’s own UI warns to use only a library from a trusted source, and Android 14’s safer dynamic-code-loading guidance is cited in the loader. Treat the downloaded `.so` as executable code with keyboard-level access, verify its provenance and ABI, and avoid random mirrors. Gesture typing itself remains local; HeliBoard advertises no Internet permission, but the provenance/privacy terms of a third-party binary still apply.

Sources: [HeliBoard README, privacy/glide typing/license sections](https://github.com/HeliBorg/HeliBoard/blob/main/README.md), [upstream loader warning and read-only copy](https://github.com/HeliBorg/HeliBoard/blob/main/app/src/main/java/helium314/keyboard/settings/preferences/LoadGestureLibPreference.kt), [Android safer dynamic code loading](https://developer.android.com/about/versions/14/behavior-changes-14#safer-dynamic-code-loading).

## Local Whisper fork audit

The fork already has the required pieces; no implementation work is needed to add swipe typing:

- `AdvancedScreen.kt` exposes `Load gesture typing library` for every build except the `nouserlib` variant.
- `LoadGestureLibPreference.kt` implements document picking, checksum validation, private-file installation, restart, and deletion.
- `JniUtils.java` defines `jni_latinimegoogle`, expects `libjni_latinime.so`, chooses the first supported ABI, checks the four upstream SHA-256 values, loads the user library, and falls back to a system Google library or the built-in native library.
- `SettingsContainer.kt` only adds gesture settings when `JniUtils.sHaveGestureLib` is true.
- `GestureTypingScreen.kt`, `GestureEnabler.java`, `PointerTracker.java`, `BatchInputArbiter.java`, and `BinaryDictionary.java` provide the settings, touch-path detection, batch input, and native suggestion handoff.
- `app/build.gradle.kts` packages `armeabi-v7a`, `arm64-v8a`, `x86`, and `x86_64`; the installed debug APK is therefore able to run the loader on any of those ABIs, provided the selected `.so` matches the device’s first supported ABI.

Relevant fork files: [JniUtils.java](https://github.com/HeliBorg/HeliBoard/blob/main/app/src/main/java/helium314/keyboard/latin/utils/JniUtils.java), [LoadGestureLibPreference.kt](https://github.com/HeliBorg/HeliBoard/blob/main/app/src/main/java/helium314/keyboard/settings/preferences/LoadGestureLibPreference.kt), [GestureTypingScreen.kt](https://github.com/HeliBorg/HeliBoard/blob/main/app/src/main/java/helium314/keyboard/settings/screens/GestureTypingScreen.kt), [PointerTracker.java](https://github.com/HeliBorg/HeliBoard/blob/main/app/src/main/java/helium314/keyboard/keyboard/PointerTracker.java).

The fork’s package/application ID changes the private files directory, but the loader uses `Context.filesDir`, so this does not require a code change. The practical next step is to obtain the matching library and load it through the existing Advanced settings entry.
