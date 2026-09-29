# Desktop installer and updates

Research checked 29 September 2026. Scope: the Windows Electron app only. The source repository was renamed to `OtherOfIce/whisper-dictation` and made public on the same day.

## What other projects do

- [Joplin's desktop build](https://github.com/laurent22/joplin/blob/dev/packages/app-desktop/package.json) uses `electron-builder` with an NSIS Windows installer and a separate portable target. Its configuration also includes signing and packaged resources. This is a close packaging example, though it does not establish Joplin's update hosting arrangement.
- [GitHub Desktop's packaging notes](https://github.com/desktop/desktop/blob/development/docs/technical/packaging.md) describe a different route: Squirrel installers, signed packages, and an S3 publishing step. [Its README](https://github.com/desktop/desktop) says older installs update to the latest version. This shows that GitHub source hosting and update hosting need not be the same.
- [Electron's own tutorial](https://www.electronjs.org/docs/latest/tutorial/tutorial-6-publishing-updating) uses GitHub Releases and its free `update.electronjs.org` service for eligible open-source apps. That tutorial uses Electron's Squirrel updater. For this app, [electron-builder's update guide](https://www.electron.build/v26/docs/features/auto-update/) is the more direct match: `electron-updater` supports NSIS on Windows, generates `latest.yml`, and can publish it with the installer to GitHub Releases.

## Does this source repository need to become public?

No. A public GitHub release repository can hold the NSIS installer, `latest.yml`, and release notes while this source repository stays private. Configure the GitHub publish provider's `owner` and `repo` explicitly so installed apps check the release repository, not an inferred source repository. This is an inference from [electron-builder's GitHub provider configuration](https://www.electron.build/v26/docs/publish/) and [GitHub's public release asset access](https://docs.github.com/en/rest/releases/assets): public assets can be downloaded without client authentication. The build workflow would need a credential with write access to the separate release repository; its normal `GITHUB_TOKEN` is scoped to the source repository, according to [GitHub Actions documentation](https://docs.github.com/en/packages/managing-github-packages-using-github-actions-workflows/publishing-and-installing-a-package-with-github-actions).

Making this repository public **would** remove that cross-repository publishing step: the build could publish a release here and installed apps could fetch it anonymously. It would also publish the code, revision history, and Actions logs, as [GitHub's visibility documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility) explains. That is a much larger decision than choosing an update feed.

Keeping the release repository private is possible, but [electron-builder's private GitHub guidance](https://www.electron.build/v26/docs/features/auto-update/) requires a `GH_TOKEN` on each user's machine and calls the provider unsuitable for general distribution. An authenticated HTTP update service is another option, but it adds account and service work. A public binary feed is the simpler fit if anyone with the link may download the installer.

## Recommendation for this app

The [current desktop package](../desktop/package.json) uses `electron-packager`, fixes its version at `0.3.0`, and has no installer or updater dependency. The [Windows build script](../tools/build-windows.ps1) publishes the self-contained .NET engine, packages Electron with the engine as an extra resource, and launches the unpacked executable.

1. Switch the Windows release build to `electron-builder` with a stable app ID, an NSIS installer, and the published .NET engine as an extra resource. Keep the app's user data outside the install directory so an upgrade replaces the app and engine together without erasing settings or history.
2. Add `electron-updater` to the installed app. Check on launch and periodically, download a newer version, and install it on a normal quit. [electron-builder documents](https://www.electron.build/v26/docs/features/auto-update/) the metadata and updater flow. Code signing is strongly preferable for distributed Windows builds; [the Windows docs](https://www.electron.build/v26/docs/win/) describe signature verification of downloaded updates.
3. Build a numbered release from a passing `main` commit. Publish the installer, matching `latest.yml`, and concise change notes to [this repository's GitHub Releases](https://github.com/OtherOfIce/whisper-dictation/releases). Each release gets a version greater than the previous one. If a bad release reaches users, publish a higher-version fix; [electron-builder's rollout guidance](https://www.electron.build/v26/docs/features/auto-update/) explains why republishing the same version will not repair already-updated installs.

The public source repository removes the need for a separate release destination or cross-repository publishing credential. The installer, updater, and release workflow were implemented in commit `d9417781`; the first release is `v0.4.1`.
