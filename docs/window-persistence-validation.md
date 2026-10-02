# Window persistence validation

The window-specific saver debounces move/resize/maximize events for 200 ms, keeps one latest valid snapshot while a write is outstanding, and drains that snapshot on close. Bounds use `getNormalBounds()` and a separate maximized flag. Minimized, fullscreen, destroyed, and demo windows do not replace the pending normal state. Bounds write failures are logged and allow close to finish; `Storage` retains its existing error recovery for later workspace and credential writes.

## Main close integration

The implementation is based on `fd6a68e`. Main's `close` listener prevents the first close, captures the final bounds, awaits the saver, then approves `created.close()` or `app.quit()`. Repeated close requests share that drain. Renderer workspace persistence retains main's existing behavior; this change adds no renderer save handshake. Issues 93 and 94 are independent, unmerged changes and are not dependencies. Their eventual integration must retain this final bounds drain alongside any close or instance handling they introduce.

## Static checks

Run from this worktree with an isolated output base:

```sh
bazel --output_base=/tmp/canopy-bazel-95 build //:build
bazel --output_base=/tmp/canopy-bazel-95 test //:test //:typecheck //:format_check --test_output=errors
```

Deterministic tests cover event bursts, a blocked write, events during close, immediate flush, maximize/unmaximize restoration, invalid snapshots, removed-monitor clamping, and final write failure. The disk regression uses a temporary directory and a bundled fake keychain to check actual workspace and credential persistence after a failed bounds replacement. It launches no Electron process and uses no live providers or credentials.

## Pending native fixture acceptance

All checks below remain pending until the lead grants the exclusive Electron token. Use the built `dist/smoke-main.cjs` fixture, the local controlled provider, and a new temporary `CANOPY_USER_DATA` directory for each scenario. Do not use `--canopy-demo` (demo intentionally skips bounds persistence). Stage the built renderer and preload with the fixture as the app manifest's `main`, as the existing smoke launcher does. Use Playwright's Electron launcher with `CANOPY_APP_PATH` and `CANOPY_ELECTRON_PATH`; keep the same disposable profile only for each scenario's relaunch. Compare saved/restored rectangles to Electron's actual `getNormalBounds()`, allowing OS sizing constraints. Remove profiles after exit. Do not change real display arrangements, OS preferences, or existing user windows.

- [ ] Move/resize burst: call `BrowserWindow.getAllWindows()[0].setBounds()` repeatedly with reachable rectangles; capture the final `getNormalBounds()`, close through `window.close()`, await process exit, and inspect `window.json`. Relaunch and compare normal bounds. Repeat with `app.quit()` issued in the same Electron evaluation as the last bounds update, before the debounce can expire.
- [ ] Maximize/unmaximize: resize to a known normal rectangle, maximize and quit; relaunch and check `isMaximized()` plus `getNormalBounds()`. Unmaximize and immediately quit; relaunch and verify the normal rectangle and `maximized: false`.
- [ ] Minimize/fullscreen: first persist known normal bounds. Minimize or enter fullscreen, then quit; verify normal bounds remain valid on relaunch and fullscreen is not restored. Confirm platform-specific native event ordering.
- [ ] Removed-monitor fixture: seed only the disposable profile's `window.json` with `{ "bounds": { "x": 100000, "y": 100000, "width": 1200, "height": 800 }, "maximized": false }`. Launch and verify bounds match `restoreWindow()` for `screen.getAllDisplays().map(display => display.workArea)`. This simulates unavailable saved display coordinates without changing monitors.
- [ ] Failure/close fixture: create a directory at the disposable profile's `window.json` after startup, resize, and close/quit. Confirm the error is logged and the process exits. Relaunch only after removing that fixture obstruction; confirm local sample workspace writes still persist. Credential failure recovery is covered with the fake-keychain unit fixture, without any live connection.
- [ ] User-dependent acceptance: after the token grant, confirm native drag/resize, maximize, and immediate quit/relaunch behavior on the required desktop platforms. Record observed results separately from deterministic fixture results; keep this acceptance pending until actually performed.
