# Window persistence validation

The window-specific saver debounces move/resize/maximize events for 200 ms, keeps one latest valid snapshot while a write is outstanding, and drains that snapshot on close. Bounds use `getNormalBounds()` and a separate maximized flag. Minimized, fullscreen, destroyed, and demo windows do not replace the pending normal state. Bounds write failures are logged and allow close to finish; `Storage` retains its existing error recovery for later workspace and credential writes.

## Main close integration

Main's `close` listener prevents the first close, captures the final bounds, awaits the saver, then approves `created.close()` or `app.quit()`. Repeated close requests share that drain. Renderer workspace persistence retains main's existing behavior; this change adds no renderer save handshake. Issues 93 and 94 are independent, unmerged changes and are not dependencies. Their eventual integration must retain this final bounds drain alongside any close or instance handling they introduce.

## Static checks

Run from this worktree with an isolated output base:

```sh
bazel --output_base=/tmp/canopy-bazel-95 build //:build
bazel --output_base=/tmp/canopy-bazel-95 test //:test //:typecheck //:format_check //:portable_checks --test_output=errors
```

Deterministic tests cover event bursts, a blocked write, debounce timing, events during close, immediate flush, maximize/unmaximize restoration, invalid snapshots, removed-monitor clamping, and final write failure. The disk regression uses a temporary directory and a bundled fake keychain to check actual workspace and credential persistence after a failed bounds replacement. It launches no Electron process and uses no live providers or credentials. Harness source controls execute the actual lifecycle helper with owned disposable Node children. They cover refused termination, hung transport close, rejected, missing, mismatched and pending acquisition, multiple owners sharing one profile, raw falsy primaries, and qualified removal. These controls establish source behavior only; they provide no native absence evidence. Every profile-bearing launch retains a separate `AuditOwner` before acquisition and confirms the exact returned process. Successful native stop retains its original evaluation and 15-second exit observation, then qualifies full-scope termination before relaunch or file changes. The unavailable-fullscreen fallback retains its transport close through qualified shutdown. Final `finishAudit` removes the profile only after every retained owner confirms settled acquisition and fresh full-scope absence. Failed or pending acquisition, refused termination, and unconfirmed absence retain the profile and fail. Forced or abnormal shutdown also fails; cleanup faults follow the original operation failure, including `false`, `0`, `null`, and `undefined`. Stop callback controls execute the actual extracted callback with owned disposable Node children under `--unhandled-rejections=throw`. They cover healthy exit, nonzero or signalled exit while evaluation is held, deadline expiry, and rejected or synchronously thrown evaluation values, including falsy primaries. Every path clears the 15-second deadline; failures retain the running owner for outer cleanup, and healthy termination returns the observed geometry.

## Actual Electron fixture checks

The exclusive lead-granted GUI token is required:

```sh
bazel --output_base=/tmp/canopy-bazel-95 run //:window_check
```

The launcher stages `dist/window-main.cjs`, renderer, and preload. The fixture uses the local controlled provider and counts calls to the real `Storage.write()` queue plus delivered native window events. The harness creates a temporary `CANOPY_USER_DATA` profile, reuses it only for its own relaunches, and removes it only after qualified termination of every launch scope. It changes only its own Electron windows, never display arrangements or existing profiles. No synthetic `emit()` events are used. The final native bounds change and close/quit request occur in one Electron evaluation, before the debounce expires. Failed assertions exit nonzero; an unavailable native fullscreen transition is explicitly reported as `pending` and does not satisfy fullscreen acceptance.

Observed on macOS / arm64 with Electron 44.3.0 on 2026-10-02, against main `2d57828` plus the issue 95 source and fixture:

- Passed: repeated native `setBounds()` movement/resize followed by immediate `window.close()` and immediate `app.quit()`, file inspection, and relaunch comparison against actual `getNormalBounds()`. Each burst delivered 24 resize events and queued zero intermediate bounds writes. Programmatic positions changed, but this session emitted neither `move` nor `moved`; physical drag event acceptance remains pending.
- Passed: maximize and unmaximize, quit, and relaunch with matching normal bounds and maximized flag.
- Passed: minimize, wait for the native minimize event, change native bounds while still minimized, verify no bounds writes, then direct window close and relaunch with the preceding normal bounds. A preliminary quit variant observed macOS restoring the minimized window before close capture; direct minimized close is the automated assertion. Physical minimized-quit ordering remains pending.
- Passed: a directory at the disposable profile's `window.json` forces the actual atomic replacement to fail. Later sample workspace and fake credential records persist through the same real queue; final failed bounds flush logs an error and direct window close exits normally. The GUI fixture writes fake credential records directly through `Storage.write('credentials', ...)`, without an OS keychain. Actual `writeSecrets()` failure recovery is covered by the fake-keychain unit regression.
- Passed: seed out-of-range saved coordinates (`x: 100000`, `y: 100000`), launch, verify the actual restored rectangle fits an available work area, then close and relaunch with matching saved bounds. No real monitor is removed.
- Pending: native fullscreen entry did not deliver `enter-full-screen` within five seconds in this desktop session, although `isFullScreen()` became true. The harness did not substitute a synthetic completion event or claim fullscreen ignored-change/relaunch acceptance.

## Pending native acceptance

Keep the PR draft until required user-dependent checks are complete. Use disposable sample profiles and an exclusive GUI token for further automated desktop runs. Further `window_check` execution also requires qualified `AuditOwner` evidence of ownership and absence before profile removal. The harness adopts the existing qualified lifecycle helper; source controls and owned Node tests do not establish Electron/native absence or grant runtime authority. Fresh complete source review and separately authorized native execution remain required.

- [ ] Complete fullscreen entry, ignored bounds changes, close/quit, and relaunch on a desktop session that delivers the native fullscreen transition.
- [ ] Confirm physical drag/resize, maximize, minimized quit, and immediate quit/relaunch ordering on macOS.
- [ ] Run the actual Electron fixture and native interactions on Windows and Linux; record results separately from macOS.
- [ ] Confirm physical monitor-removal restoration using an explicitly authorized disposable setup. The out-of-range coordinate fixture is automated coverage, not a physical display-removal result.

Real OS shutdown and live provider/credential tests are not required for this issue.
