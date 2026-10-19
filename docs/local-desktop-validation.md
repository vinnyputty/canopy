# Desktop lifecycle and large-tree performance

This layer provides single-instance focus and recreation, coalesced bounds persistence, branding and support delivery, connection setup and reviewed diagnostics, and accessibility feedback. It also provides bounded provider reads, viewport rendering, refresh ownership and cache budgets, scroll restoration, and desktop audit ownership verification. The base includes the fixture planning prototype. Workspace-close/session-end validation and release/package work remain separate.

## Source mapping

- #103: `b27c0bc` → `64fa228`.
- #113: `b27c0bc` → `0369e1c`.
- #109: `b27c0bc` → `fb899f6`.
- #106: `b27c0bc` → `70b3333`.
- #117: `a8502c1` → `176f892`.
- #122: `b27c0bc` → `d7b78ae`.
- Shared audit safety from #124 and #123 includes evidence settlement, retained-profile ownership, and independent descendant identity checks. Authoring, backup transfer, and handoff interfaces remain in the next layer.

## Invariants

Activation, duplicate launches, and support requests share window creation. Recreation waits for closing bounds persistence. Failed loads dispose only their authoritative window. Saved-maximized startup maximizes the hidden window before showing it; close and quit drain final normal bounds. Credentials stay behind the main-process storage boundary. Diagnostics require review before export, and all dialog outcomes restore focus. Accessibility announcements and keyboard navigation preserve their source behavior. Viewport rendering retains logical row membership; cache eviction never confirms unavailable data. Provider reads retain cancellation and capacity bounds. Audit cleanup preserves unresolved ownership and pending evidence work.

Run `bazel build //:build` and the existing unit, type, format, branding, and portability checks. Source checks do not qualify native focus, credential storage, provider behavior, packaging, signing, or OS session shutdown. Jira access is read-only. Exact scope, integration decisions, and check evidence are retained externally.
