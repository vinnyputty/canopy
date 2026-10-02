# Work handoff

In **Copy work brief**, choose **Custom issue context** to edit a plain text template, review its rendered text, and copy it. **Save template** keeps the template in the local workspace; **Reset template** restores the default. Copying uses the clipboard only after an explicit click. Choose where to paste the reviewed text yourself.

Allowed placeholders are `{{provider}}`, `{{key}}`, `{{summary}}`, `{{sourceUrl}}`, `{{status}}`, and `{{priority}}`. They read confirmed issue metadata and the provider source URL. Unknown placeholders, HTML in the template, control characters, and templates over 4,000 characters are rejected. Values escape HTML and remove control and direction override characters. The rendered payload is bounded to 100,000 characters. Missing source URLs are marked unavailable. Credential-bearing URLs, query strings, fragments, and URLs for another issue are rejected.

Templates do not receive connection accounts, credentials, internal storage paths, errors, comments, or descriptions. Issue metadata and user-entered template text can still contain sensitive information; inspect the rendered text before copying. The standard work brief continues to include the description and dependency links, with its existing review step. These features need no cloud service and do not launch browsers, editors, or coding agents.

## Proposed command contract — runtime pending

`parseWorkHandoffArguments` accepts exactly two arguments after the executable/app path: `--canopy-open` and a bounded `canopy://handoff/…` payload. This is a source contract for the future CLI transport, not an installed command or registered OS protocol.

Example issue payload:

```text
canopy://handoff/issue?connection=account-a&provider=github&host=github.com&root=team%2Frepo&key=team%2Frepo%2342
```

The connection ID identifies the exact locally known account without carrying its display name or credentials. Jira uses its exact known HTTPS host and issue keys, for example `root=CAN-1&key=CAN-42`. GitHub supports `github.com` only, and the issue repository must match the root repository. Root and issue membership must already be confirmed for that connection. The resolver never fetches an unknown issue, creates a connection, or selects another account.

Example saved view payload:

```text
canopy://handoff/view?view=triage
```

The view must exist uniquely in the hydrated workspace and its referenced connections must still exist. Rooted views also require confirmed snapshots for every referenced root. Deleted views and disconnected references fail without substitution. Saved view identity names the locally saved definition; it does not embed search expressions or external URLs.

Main at `5cdf719` has no single-instance command transport. Complete issue 92 on a branch stacked on reviewed issue 94, preserving its trusted-frame and focus lifecycle. The transport must validate arguments before queuing, deliver only to the current renderer after workspace hydration, bound and deduplicate pending deliveries, and cancel them across close/restart. Neither startup routing nor native focus behavior is implemented or accepted by this change.

## Disposable acceptance audit — pending fresh review and exclusive token

Use only the synthetic connections, workspace, and confirmed tree in `tests/fixtures/work-handoff.ts`. The parser tests exercise these objects without Electron, credentials, provider requests, clipboard access, or external launches. Do not turn the samples into authenticated connections.

After stacking and reviewing the transport, prepare separate temporary sample profiles for macOS, Windows, and Linux. Seed the sample workspace and use a stub provider for both account IDs. Record the exact head, OS, profile, request log, callback log, and focus observations. Keep those profiles and evidence separate from real user data.

- [ ] Launch with the valid issue payload before renderer readiness; confirm one delivery after hydration, correct account, and expected selection.
- [ ] Send the same command while running, minimized, and hidden; confirm one process, one window, correct focus, and no duplicate navigation.
- [ ] Test malformed/encoded commands and multiple arguments against both startup and running-app callbacks; confirm no delivery or provider request.
- [ ] Test both accounts with the same issue key, disconnected accounts, unknown hosts/roots/issues, deleted saved views, and stale view roots; confirm explicit failure without fallback.
- [ ] Close or restart while a command is queued; confirm no stale renderer delivery.
- [ ] Edit, save, reload, reset, and copy a custom template in the sample app; confirm the clipboard exactly matches the reviewed text and excludes connection secrets and internal paths.

Native command/focus and interactive clipboard acceptance remain pending. Browser/editor/agent destination handoff is deferred.
