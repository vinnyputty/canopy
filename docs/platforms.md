# Canopy 0.1.0 platform release notes

Canopy 0.1.0 has a candidate platform matrix, not a completed native-desktop qualification. Publish a combination only after its CI job and the native checks below pass for the exact release version. A failure or pending required check blocks that combination. CI artifacts are unsigned test downloads; uploading them does not approve a public release.

| OS / CPU                    | Pinned CI runner                     | Download formats | Minimum qualification target                       |
| --------------------------- | ------------------------------------ | ---------------- | -------------------------------------------------- |
| macOS arm64 (Apple silicon) | `macos-15`                           | DMG, ZIP         | macOS 15                                           |
| Windows x64                 | `windows-2025` (Windows Server 2025) | NSIS EXE         | Windows 11 desktop; native qualification pending   |
| Linux x64                   | `ubuntu-24.04`                       | AppImage, DEB    | Ubuntu 24.04 desktop; native qualification pending |

macOS x64, Windows arm64, Linux arm64, universal binaries, older OS versions, and other Linux distributions are outside the matrix. Windows Server CI does not establish Windows 11 desktop support. Minimum OS versions above are the conservative release requirements to qualify, not Electron's theoretical runtime floor. Do not claim compatibility with an older OS from a successful build on a newer runner. macOS packages set `LSMinimumSystemVersion` to 15.0.

Runner CPU labels are documented in the [GitHub-hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). The workflow checks the actual Node platform/CPU before running the build, and packaging rejects hosts outside this matrix. Each builder target specifies its CPU; artifact names include OS and CPU.

## Automated artifact gate

`bazel run //:ci` runs build, unit tests, type/format checks, portable tooling checks, staged smoke and demo checks, packaging, then `//:packaged_smoke`. The packaged check extracts **every** expected download format and launches its own production executable with a fresh temporary user-data directory. It verifies packaged mode and CPU, the credential-free welcome screen, preload/IPC access, empty connections, appearance save, and persistence after restart. Renderer errors and visible welcome errors fail the check. It uses no provider mocks or saved credentials and writes no credentials. GUI automation runs with networking disabled in the renderer after window creation; this is not an offline installer test.

DMG is mounted read-only, copied, and detached; ZIP is extracted with `ditto`. Windows extracts the NSIS embedded `app-64.7z` with `7z`. Linux extracts DEB with `dpkg-deb` and AppImage with `--appimage-extract`. These checks launch the extracted application payload; they do not establish native installation, upgrade, removal, AppImage FUSE launch, desktop registration, credential-store access, or signing trust. Playwright's Linux launch disables the Chromium sandbox for automation; native sandbox launch remains a desktop gate.

Only after all formats pass does the check copy the tested downloads into `.cache/verified-packages/`, with a `release-checks.json` recording version, platform/CPU, commit in CI, and SHA-256 hashes. CI uploads that directory and fails if artifacts are missing. Packaging alone writes `release/` and grants no release approval. Inspect the report and match hashes when assembling a release; do not upload unpacked builder directories or unrelated files from `release/`.

For a local packaged check, first run `bazel run //:package`, then `bazel run //:packaged_smoke`. Both commands require a matrix host. An isolated output base must also be forwarded to nested CI calls:

```sh
bazel --output_base=/tmp/canopy-bazel-76 run //:ci -- --output_base=/tmp/canopy-bazel-76
```

Automated prerequisites: Bazelisk and network access for pinned tools/dependencies/runtime; macOS `hdiutil` and `ditto`; Windows `7z` on `PATH`; Linux `dpkg-deb`, executable AppImage permissions, Electron system libraries, and a display or `xvfb-run`. These are native tools, not replacements implemented in the test. Failure to obtain them is a blocker. Packaging uses electron-builder's host installer tooling and must run on the target OS.

## Pending native desktop release blockers

All checks below are **pending user desktop access**, separately for each matrix combination and download format. Record tester, machine OS/build/CPU, release version and hash, previous version/hash for upgrade, date, result, and evidence. CI success must not mark these complete.

- [ ] Clean installation under a fresh ordinary OS account: download the exact artifact, follow the native install/open path, launch without test flags or a pre-existing profile, see the welcome screen, try the demo, and quit/relaunch. Check icons, executable permissions, and OS trust prompts. On macOS, exercise DMG copy to Applications and ZIP extraction; on Windows, run the NSIS wizard; on Linux, install DEB using the system package manager and launch AppImage directly.
- [ ] Upgrade from the previous released version with saved roots, view/appearance preferences, and an authorized test connection. Verify preferences and secure credentials survive and the native installer replaces the old application. If there is no previous release, record that fact and qualify an explicit upgrade pair before claiming upgrade support.
- [ ] Remove using the native path (Applications removal, Windows Installed apps/NSIS uninstaller, Linux package removal or deleting AppImage). Check application/launcher removal and reinstall behavior; record retained user data separately. Do not delete the user's profile to make a failed removal check pass.
- [ ] Linux desktop integration: verify DEB menu entry, icon, categories and executable target; record the AppImage launch/integration behavior actually available on the tested desktop. Check a real desktop session's D-Bus and unlocked Secret Service (for example GNOME Keyring) or KWallet. With an authorized test token, connect, quit/relaunch and confirm secure credential access; also verify the app reports missing/locked secure storage instead of accepting `basic_text`.
- [ ] Native credential storage on macOS/Windows: test with a logged-in user and functioning macOS Keychain / Windows credential encryption, including reconnect after relaunch. Real-provider checks require an explicitly supplied authorized test account/token; do not substitute mocked providers or sentinel files for credential access.

Native prerequisites: an interactive macOS 15 Apple-silicon desktop, Windows 11 x64 desktop, and Ubuntu 24.04 x64 desktop, permission to install/upgrade/remove test builds, a previous build for upgrade, and an authorized provider test account. Linux additionally needs a graphical session, an unlocked supported credential backend and session D-Bus; native AppImage mounting requires FUSE 2 compatibility (`libfuse2t64` on Ubuntu 24.04) or a separately documented extraction-only installation path. DEB installation/removal requires package-manager privileges. macOS public distribution requires Developer ID signing and notarization; current builds are unsigned. Record Windows signing/SmartScreen prompts and the intended signing policy before release.

## Release notes requirements

Copy the qualified rows and exact OS minimums into each release's notes, together with installer format/CPU, unsigned/signed/notarized status, installation prerequisites (including Linux FUSE and secure keyring), known limitations, and native check evidence. Link the matching CI run and hash report. Keep unsupported CPUs and unqualified OS versions explicit. Until the pending checks pass, label these downloads **test builds awaiting native qualification**, and leave public release blocked.
