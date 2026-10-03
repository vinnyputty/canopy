# Versioned releases

Version tags use `v<package.json version>` (for example `v0.1.0`; prereleases such as `v0.2.0-rc.1` are allowed). The tag commit, pinned Bazel/Node/npm tools and lockfile define the source build. Installer tooling and hosted runner images can vary; this is a repeatable source pipeline, not a promise of byte-identical installer rebuilds. SHA-256 identifies the exact tested bytes.

## Prepare a draft

After source review and approval, update the app version and lockfile as needed, run the checks, and create/push the matching tag. A tag push runs the issue 76 platform matrix and `//:ci` packaged verification, followed by a separately protected `windows-signing` job for Microsoft Artifact Signing Public Trust NSIS packaging, RFC 3161 timestamping and actual trust verification. A version mismatch fails before packaging. PR jobs have `contents: read`, disable signing discovery, and receive no signing secrets. Packaging keeps `publish: 'never'`. No signing credentials are required to prepare the pipeline.

The draft job has only `contents: write`. It checks all platform reports against the tag version and source SHA, requires every expected format, and recalculates each hash before attaching the downloads. It creates a **draft** using an existing tag, downloads its assets again, and verifies the uploaded bytes. Missing/stale reports, extra files, altered bytes, or failed platform jobs block the draft. A verification failure after upload leaves an unpublished draft for investigation. Reruns refuse an existing release; inspect and remove a failed draft explicitly before retrying, never overwrite a published version.

| Platform    | Release asset (`<version>` is the app version)                               |
| ----------- | ---------------------------------------------------------------------------- |
| macOS arm64 | `Canopy-<version>-mac-arm64.dmg`, `Canopy-<version>-mac-arm64.zip`           |
| Windows x64 | `Canopy-<version>-win-x64.exe`                                               |
| Linux x64   | `Canopy-<version>-linux-x86_64.AppImage`, `Canopy-<version>-linux-amd64.deb` |

Each draft also contains `SHA256SUMS` and `release-manifest.json` with version, source SHA, CI run, and asset hashes. Draft notes label these test builds awaiting native qualification, with verified Windows Authenticode signatures. Other CPUs are unqualified. Automated payload checks do not qualify installation, upgrade, removal, OS trust, or real credentials.

## Install and verify

Download the asset for your OS/CPU, plus `SHA256SUMS`. On macOS use `shasum -a 256 <asset>`; on Linux use `sha256sum <asset>`; on Windows use PowerShell `Get-FileHash <asset> -Algorithm SHA256`. Compare the entire hash and filename with `SHA256SUMS` before opening.

- macOS 15 Apple silicon: mount the DMG and copy Canopy to Applications, or extract the ZIP and move Canopy.app to Applications. Current packages are unsigned; Developer ID signing and notarization are required before public distribution. Do not bypass OS trust checks to record qualification.
- Windows 11 x64: run the NSIS EXE wizard. Windows Server CI only checks the extracted payload. The protected tag package uses Microsoft Artifact Signing Public Trust with RFC 3161 timestamps. Record native installation, upgrade, removal, publisher and SmartScreen behavior on Windows 11; a new signed app may still receive an initial reputation prompt. See [Windows signing and the guarded lifecycle fixture](windows-signing.md).
- Ubuntu 24.04 x64: install the DEB with `sudo apt install ./Canopy-<version>-linux-amd64.deb`, or make the AppImage executable with `chmod +x` and launch it directly. Native AppImage mounting needs FUSE 2 (`libfuse2t64`). Real credentials need session D-Bus and an unlocked Secret Service/KWallet backend; `basic_text` is rejected.

Installation, upgrade, removal and credential-dependent desktop checks remain pending. See [the platform checklist](platforms.md) for all prerequisites, limitations, and required evidence.

## Publish a qualified draft

Public publication is a separate manual workflow, **Publish qualified Canopy release**. Configure the `public-release` GitHub environment with required lead reviewers and restrict dispatch to reviewed source. Environment protection must be configured in repository settings; a YAML environment name alone does not create an approval gate. Do not dispatch while native acceptance is pending.

Commit `release-qualification/v<version>.json` and `release-qualification/v<version>.md` on the reviewed dispatch branch. The JSON must contain `tag`, `commit`, `status: "passed"`, `evidenceUrl`, and an `assets` array covering every exact filename/hash from the draft manifest. Each asset requires `name`, `sha256`, `nativeChecks: "passed"`, `tester`, `osBuild`, `date`, `evidenceUrl`, and `signingPolicy`. A `passed` result attests that every applicable checkbox in the platform checklist passed; the linked evidence must record each check, including the upgrade pair and authorized credential tests. macOS requires `signingPolicy: "Developer ID signed and notarized"`; Windows requires `signingPolicy: "Authenticode signed and timestamped"`; Linux must state its qualified distribution policy. Do not fabricate evidence from CI success. Current unsigned macOS downloads cannot pass this public distribution gate; signing support and fresh artifact qualification remain future work.

The Markdown is the final concise public notes: qualified OS minimums/CPU/formats, installation prerequisites, trust policy, limitations, native evidence, source SHA, CI run and checksum links. Dispatch with the existing tag after fresh review and lead approval. The publishing job runs on Windows, checks that the release is a draft, resolves the tag's source commit and reads `package.json` from that commit, independently of the dispatch branch's app version, then downloads every release asset, verifies exact names and SHA-256, and validates the committed native evidence against those hashes. It independently verifies actual Windows installer and embedded executable signatures against the approved public service root, durable publisher/profile policy, trusted timestamp/revocation and manifest hashes. Immediately before publishing it queries the remote tag, peels annotated tags to their commit, and requires that commit to match the verified manifest. Missing or moved tags block publication. Both lightweight and annotated refs are checked again immediately before the release edit; their ref name, object type, and SHA must retain the verified identity. It then changes the notes and publishes with an explicit `--tag` and `--verify-tag`. An error leaves the draft unpublished. It uses only `contents: write` and no signing secrets.

Local credential-free release logic checks run with `bazel test //:release_checks //:windows_signing_checks`; they use synthetic package bytes and reports, never launch Electron, and establish no native qualification. A release requires the real matrix, uploaded-byte verification, native evidence, review and approval.
