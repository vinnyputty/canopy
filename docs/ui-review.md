# Integrated UI review

Use the guided demo and disposable sample data for this review. It requires no provider credentials and performs no provider writes. Record the reviewed commit, OS/build, Electron version, palette, mode, reading size and spacing, window size, workflow, expected result, observed result, and evidence for each pass, failure, or pending item.

## Reproduce the sample review

Build and run the app, then follow these paths with both pointer and keyboard:

1. Start the guided demo; inspect its welcome state, provider setup guidance, and empty/loading/error states.
2. Open a sample tree, move between roots and tabs, expand a deep branch, search for an issue, and return to the tree.
3. Edit an issue inline; save, cancel, and inspect failure recovery and focus return.
4. Open an issue preview, inspect its details and actions, then close it and confirm focus and tree position.
5. Use triage and bulk actions, then create/select a saved view and refresh its results.
6. Open Settings; change palette, light/dark/system mode, reading size and spacing, and verify persistence after restart.
7. Repeat key paths in a narrow window, at 200% zoom, with long issue text, and with reduced-motion emulation. Check visible focus, names, tab order, status text, non-color state cues, contrast, and whether every action remains reachable.

Run the existing sample Electron review commands after obtaining exclusive desktop access:

```sh
bazel run //:smoke
CANOPY_SMOKE_ACCESSIBILITY_ONLY=1 bazel run //:smoke
CANOPY_SMOKE_TYPOGRAPHY_ONLY=1 bazel run //:smoke
```

The typography pass records screenshots and font/layout measurements in `.cache/typography/`. The accessibility pass records screenshots and rendered contrast measurements in `.cache/accessibility/`. Full smoke captures `.cache/tree.png` and `.cache/preview.png`. These are Chromium/sample-app observations, not native screen-reader or OS accessibility qualification.

## CI evidence

Each successful macOS, Windows, and Linux CI job uploads a separate `ui-review-<platform>` artifact, retained for 14 days. It contains only `.cache/typography/`, `.cache/accessibility/`, `.cache/tree.png`, `.cache/preview.png`, and `.cache/ui-review-evidence.json`. The manifest identifies the source revision and runner platform and records the hashes and sizes of included evidence files. Smoke failure diagnostics remain in the separate failure artifact; release packages remain in the existing package artifact.

## Remaining platform checks

Hosted Electron checks exercise the fixture on each runner, but they do not replace visual review on native desktops. Inspect light, dark, and system palettes; all reading sizes and spacing; narrow layouts; long content; deep trees; and empty/loading/error/partial-result states on macOS, Windows, and Linux. Record checks not run as pending.

Native assistive technology remains a separate qualification: VoiceOver/Accessibility Inspector on macOS, Narrator/UI Automation on Windows, and Orca/AT-SPI on Linux. Chromium accessibility snapshots and calculated contrast do not establish native announcements, native accessibility behavior, or WCAG conformance. See [the accessibility audit](accessibility-audit.md) for the detailed native checklist.
