# Canopy

A focused Electron desktop workspace for Jira issue trees, with one root issue per tab. Expand the actual parent/child hierarchy, edit summaries, priorities, assignees, and status inline, and reorder siblings using Jira rank. Linked issues appear as references that open their own tabs.

Canopy targets macOS, Windows, and Linux. The first version supports Jira Cloud and a persistent local demo; its provider boundary keeps the tree UI independent of Jira's REST payloads.

## Run

Install [Bazelisk](https://github.com/bazelbuild/bazelisk), then:

```sh
bazel build //:build
bazel test //:test //:typecheck //:format_check --test_output=errors
bazel run //:dev
```

Run `bazel run //:smoke` for an automated Electron demo test covering editing, tree controls, linked tabs, shortcuts, and persistence across restarts. It opens isolated app windows and writes a screenshot to `.cache/tree.png`; it does not use your saved connections.

Bazel downloads pinned Node.js and npm dependencies from `pnpm-lock.yaml`. You do not need a global Node.js installation. `//:dev` downloads the matching Electron runtime and starts the bundled app. Runtime downloads require network access. The app starts with a demo connection; open `CAN-100` or `CAN-200` to explore it. Demo edits are stored locally.

Use **Connect Jira site** to add a Jira Cloud site, your Atlassian account email, and a personal API token. Select **Scoped** for a token created with scopes, or **Classic** for a token created without scopes. Canopy checks `/myself` before saving the connection and uses the operating system credential store to encrypt credentials. Tokens stay in the Electron main process. Each connection is associated with a site and account.

See [Jira connection setup](docs/connections.md) for token scopes and organization policy checks. [Browser OAuth](docs/oauth.md) is an optional alternative and requires the included broker service.

## Workspace

- Open a root issue by key, Jira browse URL, or summary search. Each tab remembers its expanded nodes, hide-done setting, selection, and scroll position.
- Hide done uses Jira's Done status category and retains done ancestors with unfinished descendants.
- Double-click a summary to edit it; click priority, assignee, or status to choose a value. Jira workflow transitions requiring additional fields must be completed in Jira.
- Assignees have consistent palette colors; unassigned avatars are gray. Each distinct status shown for a connection gets its own badge color, retained as you edit, filter, and refresh your open trees.
- Drag a grab handle onto a sibling to place it before that issue. Focus a grab handle and use `Alt+↑` / `Alt+↓` for keyboard reordering. Reordering writes Jira rank; it does not change parents.
- Background refresh runs every 30 seconds and on window focus, reconciling changed issue data into the existing view.
- Open the command palette with `⌘K`, an issue with `⌘P`, or keyboard shortcuts with `⌘/` (`Ctrl` on Windows/Linux). The shortcut editor detects conflicts before saving.

Jira Cloud limits and hierarchy behavior are described in [Jira API notes](docs/jira.md).

## Packaging

```sh
bazel run //:package
```

Installers are written to `release/`: DMG/ZIP on macOS, NSIS on Windows, and AppImage/DEB on Linux. Packaging runs on the target operating system. Builds are unsigned; macOS distribution needs signing and notarization for a smooth installation experience. CI builds and checks each OS and creates platform artifacts for pull requests. GUI launch and real-site integration must also be verified on the target machine.

## Development

The renderer uses React and TypeScript. Electron's sandboxed preload exposes a narrow typed IPC API. Jira requests and credentials remain in the main process; the renderer cannot make network requests. Workspace state and demo data are stored under Electron's application user-data directory. Linux requires a working Secret Service/KWallet backend for real credentials; the insecure `basic_text` fallback is rejected.

For an editor's local `node_modules`, with Node.js available:

```sh
npx pnpm@10.22.0 install --frozen-lockfile
```

Dependency install scripts are disabled. Use the Bazel launcher to obtain Electron. To update dependencies, update `package.json`, regenerate `pnpm-lock.yaml` with pnpm 10.22.0, and run the Bazel checks. `npm run format` formats TypeScript, CSS, JSON, YAML, and documentation; Bazel files use standard Starlark formatting.

No descriptions, comments, attachments, issue creation/deletion, project moves, or reparenting are included in this version.
