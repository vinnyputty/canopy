# Canopy

A focused Electron desktop workspace for Jira and GitHub issue trees, with one root issue per tab. Expand the provider's parent/child hierarchy and open linked issues in their own tabs. Jira supports inline summaries, priorities, assignees, status, and sibling ranking. GitHub supports title, assignee, labels, and open/closed state.

Canopy targets macOS, Windows, and Linux. Its provider boundary keeps the tree UI independent of Jira and GitHub REST payloads.

## Run

Install [Bazelisk](https://github.com/bazelbuild/bazelisk), then:

```sh
bazel build //:build
bazel test //:test //:typecheck //:format_check --test_output=errors
bazel run //:dev
```

Choose **Try demo** on the welcome screen or from the sidebar or app menu to open a separate local sample workspace. Each guided step highlights its target before acting, then shows the result while its progress bar fills. **Pause demo** freezes the step until **Resume demo**; use the Previous and Next buttons or Left and Right arrows to revisit steps. **Stop demo** leaves the sample tree available, and **Reset and replay** restores its starting data. Closing the demo returns to the original Canopy window. No account or network connection is needed, and demo changes last only for that launch. From a source checkout, `bazel run //:demo` opens the same experience and `bazel run //:demo_check` runs its Electron interaction checks.

Run `bazel run //:smoke` for an automated Electron demo test covering editing, tree controls, linked tabs, shortcuts, and persistence across restarts. Failures print visible app errors and recent process output, and save a screenshot plus `failure.json` under `.cache/smoke-failure/`; CI uploads these as `smoke-failure-<OS>` artifacts. Set `CANOPY_SMOKE_TEST_DIAGNOSTICS=1` to verify capture with an intentional failure. It opens isolated app windows and writes a screenshot to `.cache/tree.png`; it does not use your saved connections.

Run `bazel run //:smoke_github` for a focused Electron test with mocked GitHub API responses covering connection, cross-repository sub-issues, edits, labels, and grouped search. It uses isolated app data and does not use your saved credentials.

Run the full CI sequence locally with:

```sh
bazel run //:ci
```

This builds, tests, checks the Bazel scripts from an unrelated working directory, runs the Electron smoke and guided demo checks, and packages Canopy. The extra working-directory check catches cross-platform runfiles assumptions before remote CI. Packaging produces installers only for the host operating system, so run it on each target OS to verify every installer format. Headless Linux needs `xvfb-run`. Windows uses PowerShell or Command Prompt. Bazel supplies Node.js for the runner. For an isolated Bazel output directory, use `bazel --output_base=/tmp/canopy-bazel run //:ci -- --output_base=/tmp/canopy-bazel`.

Bazel downloads pinned Node.js and npm dependencies from `pnpm-lock.yaml`. You do not need a global Node.js installation. `//:dev` downloads the matching Electron runtime and starts the bundled app. Runtime downloads require network access. Normal builds start with your saved Jira connections. The local sample provider powers both the guided demo and the smoke-test entry point; smoke-only failure controls stay in the test fixture.

Use **Connect Jira site** to add a Jira Cloud site, your Atlassian account email, and a personal API token. Select **Scoped** for a token created with scopes, or **Classic** for a token created without scopes. Canopy checks `/myself` before saving the connection and uses the operating system credential store to encrypt credentials. Tokens stay in the Electron main process. Each connection is associated with a site and account.

See [Jira connection setup](docs/connections.md) for token scopes and organization policy checks. [Browser OAuth](docs/oauth.md) is an optional alternative and requires the included broker service.

Use **Connect Jira or GitHub → GitHub** to connect selected repositories with a fine-grained personal access token. Open a repository root to browse all issues with native sub-issue nesting, or open one issue as a focused tree. See [GitHub connection setup](docs/github.md) for permissions, search, hierarchy, and writable actions.

Recently saved Jira fields and sibling placement remain visible while search catches up. Reconciliation covers the last 50 changed issues per connection for up to five minutes; rank undo remains retryable during catch-up. See [Jira consistency limits](docs/jira.md).

## Workspace

- Open a Jira root by exact key or browse URL, or find it by key prefix or summary. Open a GitHub root by selected repository, `owner/repo#number`, issue URL, or repository and issue search. Enter opens a typed direct reference; use Up/Down and Enter to open a suggestion. Load additional matches on demand. Each tab remembers hierarchy and linked-issue expansion, filters, subtree focus, hide-done setting, selection, and scroll position.
- Find loaded hierarchy keys and titles with `⌘F` / `Ctrl+F`. Search and assignee/status/priority filters show matches with ancestor paths; clearing them restores the saved expansion. Search is temporary per tab. Assigned-to-me uses your Jira account ID.
- Expand opens hierarchy descendants; double-click or `Alt`-click includes linked issues. From a fully expanded tree, Collapse first hides links, then hierarchy; double-click or `Alt`-click collapses both. Tree actions also expose linked expansion, depth controls, selected-branch controls, subtree focus, reveal-selection, and back-to-root.
- Breadcrumbs navigate subtree focus. Reveal-selection temporarily includes a filtered-out selection without clearing filters. Collapsed rows show open/total direct children; hover the count for total descendants. Counts use the unfiltered hierarchy and Jira’s Done category.
- Hide done uses Jira's Done status category and retains done ancestors with unfinished descendants.
- Use **View** to show or hide columns, change their order, and choose Small/Medium/Large text independently of Compact/Comfortable row spacing. Drag column dividers to resize, use arrow keys on a focused divider for 10px steps, or double-click to reset its width. Issue stays first and visible; row actions stay last. Headers remain visible as the tree scrolls.
- Click a column header to sort siblings ascending or descending while keeping descendants with their parents. Priority follows Jira's configured order, with highest first; Issue sorts by summary. Select **Jira rank** in View to return to Jira order.
- Each root remembers its columns, widths, sorting, hide-done setting, and reading preferences even after closing its tab. **Use as connection default** applies its view to uncustomized roots on that Jira connection. **Reset this root to default** clears the root's full override.
- Saved views collect matching issues across chosen roots or all configured roots on selected connections. The starter views cover issues assigned to you, a literal `Blocked` status, and common review status names; edit their sources, filters, and sort in **Edit view**. Results show provider, connection, and source root, and **Open in tree** reveals the issue in its hierarchy. An issue under several selected roots appears once per connection, with the first selected root as its source.
- Double-click a summary to edit it; click priority, assignee, or status to choose a value. Use **Open in Jira** beside workflow transitions requiring additional fields; returning refreshes the tree and available choices.
- Use **Assign to me** in an issue’s assignee picker to assign it to the signed-in account for that connection. Canopy checks assignment eligibility and supports undo.
- Select multiple tree rows with Command/Control-click or Shift-click to copy their keys and summaries, assign, change Jira priority, or move to a common status. Review per-issue eligibility before applying; failures have Retry and supported edits have Undo. See [bulk triage](docs/workspace.md#bulk-triage).
- Assignees have consistent palette colors; unassigned avatars are gray. Familiar status names use consistent badge colors across connections when their Jira category or GitHub state agrees. Custom statuses use stable, distinct colors within their category across refreshes and restarts; the status text identifies the workflow state.
- Inline edits and sibling ranking appear immediately in every open tree for the same Jira connection. A saving indicator stays visible until Jira responds; failed edits restore the last confirmed value without losing newer edits.
- Press `Enter` to edit the focused field (or the selected row’s summary), `Escape` to cancel, and `Tab` / `Shift+Tab` to advance through visible columns in their configured order and through the displayed sorted hierarchy. Use `↑` / `↓` to choose assignees and status transitions. Summary drafts survive background refreshes. Edited and pending rows remain visible through filters and keep their position during column sorting until the edit settles.
- Use the post-change Undo action or `⌘Z` / `Ctrl+Z` outside text fields to undo completed edits and ranking during the current session. Undo checks current Jira values and workflow options first; unavailable inverses are reported and skipped. Jira does not provide an atomic compare-and-set for these writes, so another remote edit can still race the check.
- In Jira rank order, drag a grab handle onto a sibling to place it before that issue, or focus a handle and use `Alt+↑` / `Alt+↓`. Handles appear for issues with verified ranking permissions and are disabled during column sorting. Reordering writes Jira rank; it does not change parents.
- The active tab refreshes every 30 seconds. Background tabs (including all tabs while the window is unfocused) back off from one minute to one hour. Activating a tab or returning to the window refreshes the active tree and resets its cadence. Refresh preserves your place and waits for active edits and pending writes. The footer shows the last successful update and connection state; failed refreshes retain the tree and offer Retry. Offline polling pauses until connectivity returns. Overlapping trees share identical in-flight Jira reads on the same connection. Jira rate limits pause all requests on that connection until `Retry-After` expires (or an increasing fallback delay); the tree stays visible, sync status shows the recovery time, and the active tab resumes first.
- Quit with `⌘Q`, toggle the sidebar with `⌘B`, and select tabs 1–9 with `⌘1`–`⌘9` (`Ctrl` on Windows/Linux).
- Open **Appearance** in the sidebar to choose Default, Ocean, or Forest and a System, Light, or Dark mode. Every palette has light and dark variants; System follows the operating system. The whole window previews changes until you save or cancel. Saved choices persist across restarts, and existing workspaces retain their current mode with the Default palette.
- Drag tabs to reorder, right-click for root actions, and pin favorites independently of open tabs. Reopen closed tabs with `⌘⇧T` / `Ctrl+Shift+T`; use Back/Forward to restore visited positions. See [workspace controls](docs/workspace.md) for saved layouts and keyboard controls.
- Press `Space` on a focused issue row to preview its description, recent comments, and directional links. Resize the preview with its drag handle or arrow keys; `Escape` closes it and restores tree focus.
- Right-click a row, press `Shift+F10`, or use its actions button to copy its key, title, link, or Markdown work brief, or open the issue in its provider. The preview also offers **Copy work brief**. Review the exact text before copying; the brief includes identity, source, status, priority, parent path, description, and dependency links when available. Hover a truncated title to read it in full.
- On a Jira row, choose **Create child issue** to add a child using the issue types and fields available for that parent. Jira screens requiring other fields offer a link to the parent in Jira.
- Open the command palette with `⌘K`, an issue with `⌘P`, or keyboard shortcuts with `⌘/` (`Ctrl` on Windows/Linux). The shortcut editor detects conflicts before saving.

Priority, assignee, and status pickers load independently with field-specific Retry actions. Assignee suggestions use the last 100 people seen on the connection; selection checks issue eligibility, and search or Load more fetches additional results within Jira’s 1,000-user discovery limit.

Jira roots prefetch status choices by issue type so child menus open with cached transitions. The View menu’s default-on sharing setting can be disabled per root. Full workflow prefetch needs Jira workflow-view or admin permission; otherwise Canopy prefills statuses represented in the open tree.

Jira Cloud limits and hierarchy behavior are described in [Jira API notes](docs/jira.md).

## Packaging

```sh
bazel run //:package
```

Installers are written to `release/`: DMG/ZIP on macOS, NSIS on Windows, and AppImage/DEB on Linux. Packaging runs on the target operating system. Builds are unsigned; macOS distribution needs signing and notarization for a smooth installation experience. CI builds and checks each OS and creates platform artifacts for pull requests. GUI launch and real-site integration must also be verified on the target machine.

## Development

The renderer uses React and TypeScript. Electron's sandboxed preload exposes a narrow typed IPC API. Jira requests and credentials remain in the main process; the renderer cannot make network requests. Workspace state is stored under Electron's application user-data directory. Linux requires a working Secret Service/KWallet backend for real credentials; the insecure `basic_text` fallback is rejected.

For an editor's local `node_modules`, with Node.js available:

```sh
npx pnpm@10.22.0 install --frozen-lockfile
```

Dependency install scripts are disabled. Use the Bazel launcher to obtain Electron. To update dependencies, update `package.json`, regenerate `pnpm-lock.yaml` with pnpm 10.22.0, and run the Bazel checks. `npm run format` formats TypeScript, CSS, JSON, YAML, and documentation; Bazel files use standard Starlark formatting.

Editing descriptions and comments, attachments, issue deletion, creating issues outside Jira child rows, project moves, and reparenting are not supported in this version.
