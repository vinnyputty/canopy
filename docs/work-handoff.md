# Work handoff

In **Copy work brief**, choose **Custom issue context** to edit a plain text template, review its rendered text, and copy it. **Save template** keeps the template in the local workspace; **Reset template** restores the default. Copying uses the clipboard only after an explicit click. Choose where to paste the reviewed text yourself.

Allowed placeholders are `{{provider}}`, `{{key}}`, `{{summary}}`, `{{sourceUrl}}`, `{{status}}`, and `{{priority}}`. They read confirmed issue metadata and the provider source URL. Unknown placeholders, HTML in the template, control characters, and templates over 4,000 characters are rejected. Values escape HTML and remove control and direction override characters. The rendered payload is bounded to 100,000 characters. Missing source URLs are marked unavailable. Credential-bearing URLs, query strings, fragments, and URLs for another issue are rejected.

Templates do not receive connection accounts, credentials, internal storage paths, errors, comments, or descriptions. Issue metadata and user-entered template text can still contain sensitive information; inspect the rendered text before copying. The standard work brief includes the description and dependency links, with its review step. A preview returned for another issue is refused before either copy format opens. These features need no cloud service and do not launch browsers, editors, or coding agents.

## Open an existing issue or saved view from a terminal

Run the Canopy executable with `--canopy-open` followed by one quoted payload. The app opens normally if it is not running; an existing instance receives the command and uses its existing window. This optional CLI does not install or register an OS protocol.

```sh
Canopy --canopy-open 'canopy://handoff/issue?connection=account-a&provider=github&host=github.com&root=team%2Frepo%2342&key=team%2Frepo%2343'
```

The connection ID must identify the exact locally known account. IDs such as `github:HASH`, `token:HASH` and `GRANT:SITE` are opaque local identifiers, not API tokens. Obtain the exact ID from your local workspace's connection references; do not put account names, tokens, or credentials in the payload. Jira uses its exact known HTTPS host and issue keys, for example `root=CAN-100&key=CAN-111`. GitHub supports `github.com` only, and the issue repository must match the root repository. Entire `.` and `..` repository segments are rejected, including encoded forms. Dotted names remain supported.

The root must already be known in the workspace, with a confirmed tree containing the issue. The app selects that exact root and issue, expands its ancestors, and reveals it through current filters without changing saved filters or Hide Done. An existing root tab keeps its settings and ID. Unknown roots/issues and unconfirmed data fail with a generic visible error; the command does not fetch an arbitrary issue, create a connection or substitute another account. The handoff does not force the preview pane open.

Open a saved view by its exact existing local ID:

```sh
Canopy --canopy-open 'canopy://handoff/view?view=triage'
```

The view must exist uniquely, its referenced connections must still exist, and every configured source must have confirmed data in the current renderer. Deleted views, disconnected references, and unavailable sources fail without selecting another view or loading a new root.

Development launch forwards the same arguments:

```sh
bazel run //:dev -- --canopy-open 'canopy://handoff/view?view=triage'
```

For a deliberately isolated demo profile, the direct development executable convention is `electron APP_PATH --canopy-demo --canopy-open PAYLOAD`; a packaged executable omits `APP_PATH`. The pinned Playwright runtime prefix `--inspect=0 --remote-debugging-port=0` (preceded by `--no-sandbox` on Linux) is consumed only before the application path or packaged application arguments. The optional Linux runtime suffix `--no-sandbox` is consumed only as the final argument. The issue parser supports Jira/GitHub identities; the ordinary demo connection has no external provider host, so its issues are unavailable through this command. Unknown switches, extra arguments, arbitrary URLs and multiple commands in one invocation are refused. The running owner and duplicate must use the same main/demo mode and OS user profile.

## Delivery and ownership

The single-instance lock carries the original bounded application arguments in [`additionalData`](https://www.electronjs.org/docs/latest/api/app#event-second-instance), avoiding Electron's reordered second-instance argv. The duplicate exits before reading, writing or cleaning the owner's profile. The owner revalidates the payload before admission to one FIFO shared by startup and running-app commands. Focus and window recreation use the existing single-instance lifecycle.

The FIFO holds at most 16 pending/current commands, deduplicates only equivalent pending/current intents, and preserves distinct admission order. Completed commands can be sent again. Commands expire 60 seconds after admission; a delivered command has at most 10 seconds to be acknowledged. Overflow, expiry and invalid/unavailable targets produce a bounded generic rejection notice without echoing command text. A failed command releases the head of the queue.

The renderer subscribes, then announces readiness after workspace hydration and initial normal tree reads settle (or the app is offline). It resolves each command against current connections, workspace and confirmed snapshots. Navigation commits before acknowledgment permits the next delivery. Each readiness request has a fresh client ID; replacement clients get a new session so late cleanup cannot cancel replacement work. Each delivery carries a renderer session, unique request ID and expiry. IPC readiness, acknowledgment and cancellation require the current trusted main frame at the bundled file URL. There is no polling or command-triggered provider search.

Close, non-same-document navigation, renderer crash/destruction and quit cancel outgoing commands and acknowledgments. A command received after a close begins can wait for the existing window recreation path and a new hydrated renderer session. It is not delivered to the closing renderer. Same-document navigation keeps the current session. These source behaviors do not establish native OS focus acceptance.

## Disposable native audit — pending fresh review and exclusive token

`//:handoff_check` is a manual desktop target. Build it without executing it while native acceptance is held. The target uses the exact merged issue 85 ownership helper (`f3305334`) and requires a single reviewed head label before staging or launch. The label is an operator input, not evidence of approval. After fresh combined source review, source/build/runtime binding and an exclusive lead token, the command is:

```sh
bazel run //:handoff_check -- REVIEWED_40_CHARACTER_HEAD
```

The audit creates and permanently retains a marked temporary sample profile. Its adapter registers a canonical owner before each primary or direct duplicate launch and retains original launch, UI, close and filesystem promises beyond deadlines. Cleanup success requires their settlement and canonical fresh descendant absence. The adapter reads the original child and root birth evidence from the pinned helper’s retained scope; these read-only implementation fields are a compatibility dependency. A duplicate that exits before root birth capture fails and retains the profile, even if the canonical helper reports absence. It does not delay the duplicate’s ordinary exit, invent birth evidence or create another signaling authority. A public canonical birth-evidence API is needed to remove that implementation-field dependency. Its fixture uses `handoff-audit-main.cjs` with synthetic Jira metadata and no credential loading, and the workflow retains profile/results as evidence. The fixture verifies the disposable profile and bounded regular marker file only after acquiring the instance lock. The workflow checks startup navigation, a second CLI launch while minimized, one-window focus restoration, and an explicit sample context copy delivered through the actual main IPC handler into an isolated, bounded sample sink. The fixture permanently denies external browser launches and network fetches before UI creation. Demo connections refuse real authentication/provider access. It replaces main clipboard methods before the UI starts and rejects native reads and other writes; no system clipboard content is captured. Fixture recreation failures retain the active sink so the existing window can continue safely. Original method descriptors are restored only on actual quit or process exit, preserving foreign method ownership. The sink comparison does not qualify real system clipboard integration. It installs no protocol and performs no external handoff. This target has not been executed as part of source implementation.

- [ ] Review the shared ownership adapter and run the audited CLI/sample-sink target on macOS, Windows and Linux at the freshly reviewed head under the exclusive native token.
- [ ] Verify distinct command order and duplicates during held startup/close/recreation on each OS.
- [ ] Verify unavailable/disconnected accounts, unknown hosts/roots/issues, deleted views, stale sources and malformed command invocations leave the selection unchanged and show a safe error.
- [ ] Verify hidden/minimized focus and native macOS Dock activation under issue 94's retained acceptance gates.
- [ ] Edit, save, reload and reset the custom template in the disposable app; verify privacy boundaries and exact reviewed sample-sink text. Real system clipboard integration requires separate authorized native acceptance.

Native duplicate-launch/URL/focus and interactive clipboard/persistence acceptance remain pending. Browser/editor/agent destination handoff is deferred.
