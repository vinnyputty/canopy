# Native workspace close verification

Run these checks on a disposable desktop session with the issue #93 build. Windows logout, restart, and shutdown use native session events that an automated event simulation cannot verify. Repeat logout and restart on macOS and Linux. Record the OS/version, commit, termination action, observed shutdown behavior, and reopened workspace for each result. No provider credentials are needed.

## Isolated fixture setup

Build with `bazel build //:build`. Run `bazel run //:smoke` once to download the matching Electron runtime. Its runtime directory is `<system temporary directory>/canopy-electron-<Electron version>-<platform>-<architecture>`. Get the version from `package.json`, and the platform and architecture with `node -p "process.platform + '-' + process.arch"`. The executable is `electron.exe` on Windows, `electron` on Linux, or `Electron.app/Contents/MacOS/Electron` on macOS.

Create a new temporary profile and keep its path for reopening. Do not use an existing Canopy profile.

On macOS/Linux:

```sh
profileDir=$(mktemp -d -t canopy-close-check.XXXXXX)
printf '%s\n' "$profileDir"
```

On Windows PowerShell:

```powershell
$profileDir = Join-Path ([IO.Path]::GetTempPath()) ('canopy-close-check-' + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $profileDir
```

Save this JSON as `workspace.json` in that directory before launching. It opens local fixture issues and gives the first root a changed unread summary:

```json
{
  "tabs": [
    {
      "id": "CAN-100",
      "connectionId": "demo",
      "rootKey": "CAN-100",
      "expanded": [],
      "hideDone": false,
      "scrollTop": 0
    },
    {
      "id": "CAN-200",
      "connectionId": "demo",
      "rootKey": "CAN-200",
      "expanded": [],
      "hideDone": false,
      "scrollTop": 0
    }
  ],
  "activeTabId": "CAN-100",
  "theme": "dark",
  "sidebarCollapsed": false,
  "shortcuts": {},
  "seenRoots": {
    "demo:CAN-100": {
      "touchedAt": 1,
      "issues": {
        "CAN-100": { "seenAt": 1, "fields": { "Summary": "Old summary" } }
      }
    }
  }
}
```

Set `electronPath` to the executable path above, then launch the fixture entry point from the repository:

```sh
CANOPY_USER_DATA="$profileDir" "$electronPath" bazel-bin/dist/smoke-main.cjs
```

```powershell
$env:CANOPY_USER_DATA = $profileDir
& $electronPath 'bazel-bin/dist/smoke-main.cjs'
```

The fixture stores local sample issue edits in this profile. Reopen with the same command and directory after every native termination. A temporary directory may be cleared on reboot; if your OS does so, create a new disposable directory that survives reboot and use it as `profileDir` instead.

## Successful termination

For each native logout, restart, and shutdown case:

1. Start from the seeded profile. Close the `CAN-200` tab, enable **Hide done**, select a priority filter, set **Text size** to **Small** in the view settings, and choose **Mark root seen**.
2. Trigger the native OS action promptly after the last change. Record whether the OS proceeds, delays, cancels, or asks to terminate Canopy. Do not force termination for the successful-save case.
3. Sign back in or restart, then launch the fixture with the same profile. Verify the closed tab stays closed, **Hide done** is enabled, the priority filter and small text remain, and the root is marked seen. Compare `workspace.json` before and after if any state differs.
4. Re-seed the profile between cases while Canopy is closed.

Automated smoke holds the debounce deterministically and verifies close/quit persistence. Native checks establish the OS termination behavior; manual timing alone does not prove that a debounce was pending.

## Controlled write failure

With the fixture open and idle, move the saved `workspace.json` to a backup, then create an empty directory at `workspace.json`. This blocks replacement of the destination regardless of temporary-file naming. Keep the saved-file backup for recovery; window-bounds writes use a separate destination:

```sh
mv "$profileDir/workspace.json" "$profileDir/workspace.close-check-backup.json"
mkdir "$profileDir/workspace.json"
```

```powershell
Move-Item -LiteralPath (Join-Path $profileDir 'workspace.json') -Destination (Join-Path $profileDir 'workspace.close-check-backup.json')
New-Item -ItemType Directory -Path (Join-Path $profileDir 'workspace.json')
```

Toggle **Hide done** and trigger the native logout or shutdown action. Record whether Canopy can retain its window, whether **Couldn’t save workspace** remains visible, and what the OS does with the delayed/failed termination request. Verify `workspace.close-check-backup.json` retains the previous saved state. If the OS forces termination, record that limitation explicitly; a forced process exit cannot await persistence.

Before restarting Canopy, remove only the empty blocker directory and restore the backup. If the desktop remains available, do this while Canopy is still open, then retry the native action:

```sh
rmdir "$profileDir/workspace.json"
mv "$profileDir/workspace.close-check-backup.json" "$profileDir/workspace.json"
```

```powershell
Remove-Item -LiteralPath (Join-Path $profileDir 'workspace.json')
Move-Item -LiteralPath (Join-Path $profileDir 'workspace.close-check-backup.json') -Destination (Join-Path $profileDir 'workspace.json')
```

Reopen and verify the latest change persisted. Close the fixture before deleting its disposable profile, and clear `CANOPY_USER_DATA` from a PowerShell session when finished.
