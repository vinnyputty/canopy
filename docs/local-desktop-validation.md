# Desktop source integration

The desktop feature candidate combines the source features below. Its base is `8ba36a3864dddb28778b304a8ffde0cd43d2402c`, which includes the planning prototype. Release/package PRs #108, #110, #119, and #121 remain separate.

## Pinned source

- #103 `fix/94-single-instance`: `b27c0bc8dcc17cf09198d09245d0aa76c52341e8` → `64fa228f62f37ab2b31d2aed7d1a78ec314f5a5d`.
- #113 `fix/95-window-write-coalescing`: `b27c0bc8dcc17cf09198d09245d0aa76c52341e8` → `0369e1cad755b4b787bd3002df2991d3f26890d3`.
- #106 `feat/82-connection-setup`: `b27c0bc8dcc17cf09198d09245d0aa76c52341e8` → `70b3333943e4a926c6cb398501c50f404873e2d7`.
- #109 `feat/79-branding-support`: `b27c0bc8dcc17cf09198d09245d0aa76c52341e8` → `fb899f6b334e4759fbc12d9619ee1f5e7e3f1d3f`.
- #117 `fix/88-accessibility`: `a8502c1c50ed82be986770f04d4ae6aae742514a` → `176f892d31e28b2a8204801a02e53d759f8c4d08`.
- #122 `perf/90-large-trees`: `b27c0bc8dcc17cf09198d09245d0aa76c52341e8` → `d7b78ae3c99c121a669d2922d1dbe0e401e91ef6`.
- #123 `feat/89-workspace-backup`: `b27c0bc8dcc17cf09198d09245d0aa76c52341e8` → `47ebc551556460dbde84d6eac16caff3c0994ea3`.
- #124 `feat/87-rich-authoring`: `b27c0bc8dcc17cf09198d09245d0aa76c52341e8` → `0a0fb047ba59516f1e2bceb91e193bb5279ff02d`.
- #125 `feat/92-work-handoff`: `64fa228f62f37ab2b31d2aed7d1a78ec314f5a5d` → `6fcc16805afa02fda9c0fce2657898b0f2ff79a2`.
- #126 `explore/91-planning-views`: `b27c0bc8dcc17cf09198d09245d0aa76c52341e8` → `f050f2a3e6ce09dab2bb1db1555448bc48cfa0c1` (inherited from the base).

## Integration invariants

- Activation, duplicate launches, and About & Support share one window-creation promise. Failed loads dispose only their authoritative window.
- Move and resize events debounce to the latest bounds. Close and quit drain the final bounds before disposing the window.
- Backup transfer blocks old-document saves. Committed transfers retain their old-document save barrier through reload failure. Failed operations restore normal saves. Atomic replacement retains private unique staging, fresh approval checks, and cleanup.
- Handoff startup readiness records completed initial reads independently of cache retention. Destination resolution requires retained confirmed data. Saved-view handoff exits Inbox before activating its destination.
- Accessibility feedback, viewport rendering, cancellable provider reads, authoring recovery, setup diagnostics, and support delivery retain their source invariants. Tree, search, relationship, and handoff owners are released on document teardown.

## Validation scope

Run `bzll build //:build` and `bzll test //:test //:typecheck //:format_check //:branding_check //:portable_checks --local_test_jobs=1 --test_output=errors`. The portability target repeats source checks from an unrelated working directory. Callback tests use controlled Electron boundaries and real workspace storage; they do not qualify native focus, OS session shutdown, secure credential storage, provider behavior, packaging, or signing.

Full provenance, exact historical outcomes, reproduction logs, and mutation results are retained outside the repository at `/Users/vinay/repositories/canopy-validation-20261018/integration`.

## Final Windows validation

- Build the desktop feature candidate and record the exact source revision and executable payload.
- Verify duplicate-launch exclusion, focus/restoration, recreation, and handoff delivery across startup, window recreation, and restart.
- Verify move/resize bursts, maximized restore/unmaximize normal bounds, and final bounds drain on close and quit.
- Verify held Apply/Undo rejects old-document saves, failed reload preserves imported bytes and the save barrier, and failed transfer restores ordinary persistence.
- Verify Inbox-to-saved-view handoff, startup cache eviction readiness, and refusal of targets whose confirmed data is unavailable.
- Use synthetic providers for mutation fixtures. Jira verification is read-only. Record remaining native or provider limitations explicitly; release prerequisites and signing remain separate gates.
