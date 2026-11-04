# Shared visual styles

`src/renderer/styles.css` defines the visual contract for every provider, palette, and theme. Use its existing semantic colors (`--bg`, `--panel`, `--panel-raised`, `--text`, `--muted`, `--accent`, `--selected`, `--selected-border`) for surfaces and state. Palette values remain shared across workspace screens and dialogs.

Typography uses `--font-ui`: `system-ui`, `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, then `sans-serif`. macOS resolves its system face locally; no Apple font files are bundled or fetched. Form controls, including textareas, inherit UI typography. Code, preformatted content, and keyboard hints use `--font-mono`.

Use `--font-size-caption` (12px) for supporting labels, `--font-size-body` (13px) for controls and body text, `--font-size-title` (15px) for issue titles and small headings, `--font-size-section` (16px), and `--font-size-page` (24px). `--line-height-body` is 1.5 for reading surfaces; `--line-height-heading` is 1.25. Fixed workspace chrome retains native leading. Tree reading settings retain their independent 11/13/15px sizes through `--tree-font-size`.

Spacing uses `--space-1` through `--space-6`: 4, 8, 12, 16, 24, and 32px. Shared controls use `--control-height` (32px) and `--radius-control` (6px). `--radius-panel` is 8px; dialogs use `--radius-dialog` (12px). Existing dense icon controls retain their dimensions. `--border` and `--border-soft` separate surfaces; `--control-border` gives actionable control boundaries stronger contrast. `--focus-ring` follows `--selected-border` across palettes. Text and icons remain explicit alongside status colors.

Fresh workspaces and Reading reset use Medium / Comfortable. Saved workspaces without reading settings retain Medium / Compact unless a valid legacy view supplies another choice. Explicit global reading wins over legacy view preferences. The guided demo explicitly starts with Medium / Comfortable. Reading controls persist immediately and root resets preserve them.

## First run and settings

The welcome surface uses a single readable column with visible Connect, Try demo, Setup help, and Keyboard shortcuts actions. Provider requirements are shown before setup; token permission details link to the provider’s token settings. The demo opens a separate sample workspace without credentials. Startup displays a loading status before offering connection actions. Offline trees explain how to reconnect; filtered empty results clear the current root’s search, filters, and hidden completed issues and return focus to Find in tree.

Settings groups Reading, Appearance, Workspace and help, then Updates. Reading and update preferences save immediately. Appearance previews throughout the window; Save persists it, Cancel restores the saved theme and palette, and Reset appearance previews System / Default until Save. Backup metadata details remain available before reviewing export or import.

The tour’s opening caption explains Pause and Resume; its completion caption points to Settings and Close demo. Existing tour targets and accessible action labels remain stable.

## Verification

After obtaining exclusive desktop ownership, run:

```sh
CANOPY_SMOKE_TYPOGRAPHY_ONLY=1 bazel run //:smoke
CANOPY_SMOKE_ACCESSIBILITY_ONLY=1 bazel run //:smoke
bazel run //:smoke
```

The typography check launches the production app with fresh data, checks Comfortable, then launches the fixture with saved data lacking reading settings and checks Compact. It exercises all six size/spacing combinations with a long multilingual issue title, captures screenshots under `.cache/typography/`, records actual Chromium platform fonts (including fallback glyph fonts), checks native font use in controls, and verifies reading persistence after restart. It uses temporary owned profile data.

The accessibility check captures all palette/theme combinations, focus states, and rendered contrast measurements under `.cache/accessibility/`. Inspect these screenshots for clipped badges, disabled controls, long text, narrow windows, and focus visibility. Full smoke covers navigation, editor/picker errors, cancellation, focus restoration, and reading reset. These checks must also run on Windows and Linux; a macOS result does not qualify their font fallback rendering or desktop interactions.

First-run/settings desktop acceptance remains pending until exclusive GUI access is allocated. Run `bazel run //:smoke_github` for isolated setup dismissal, failed verification/retry, and diagnostics; `bazel run //:smoke` for settings save/cancel, focus restore, reading persistence, empty and offline states; and `bazel run //:demo_check` for pause/resume/seek/reset/exit. Inspect fresh welcome and connected empty workspace, provider setup, Settings, help, backup, and update states at narrow sizes and all palettes/themes. Repeat on Windows and Linux (Linux GUI automation uses `xvfb-run`) before claiming native validation.
