# Large-tree performance audit

The benchmark executes production Jira/GitHub parsers and hierarchy traversal against deterministic fake transports, plus the production tree, filter, reconciliation, saved-view, and shared refresh functions. It uses a 9,901-issue wide root, a 10,101-issue three-level hierarchy, and a 2,001-issue chain for each provider. The chain is an adversarial depth stress fixture, not a claim about ordinary Jira hierarchy depth. Fields include realistic summaries, assignments, statuses, priorities, activity, links, labels, comments and unused GitHub body text. The six-root saved view deduplicates and naturally sorts real parsed issues.

Run from the repository with dependencies installed:

```sh
node --expose-gc tools/benchmark-large-trees.mjs
CANOPY_PERF_LATENCY_MS=2 node --expose-gc tools/benchmark-large-trees.mjs
```

To compare a baseline, archive its `src` into a disposable directory and set `CANOPY_PERF_SOURCE` to that directory and `CANOPY_PERF_HEAD` to its full commit ID. The same fixture/harness loads production modules from that directory. CPU measurements report the median of five synchronous runs; provider loads and the concurrent six-root refresh report one wall-time sample. The refresh has eighteen consumers but six real provider reads. The optional delay is synthetic round-trip latency, not live-provider timing. Heap deltas are GC-retained Node data measured after allocating wire fixtures; they exclude fixture construction, Chromium and Electron. Reconciliation includes cloning the received snapshot. No benchmark number is a browser scroll, paint or interaction measurement.

The initial `30c57db` measurements justified linear parent-cycle classification and reuse of a collator for saved-view sorting. Provider request counts justified progressive delivery and cancellation during long reads. Expanded DOM volume alone did not establish a scrolling bottleneck, so the tree keeps its existing row rendering and keyboard, selection, expansion, hidden-Done, focus, scroll, ranking and drag behavior.

## Desktop acceptance (pending)

Source review precedes changed GUI acceptance. All Electron/GUI/clipboard work requires an explicitly granted exclusive desktop token. No desktop results are included in the Node benchmark. `tools/perf-desktop.mjs` checks for a token and executable before importing the Electron launcher. Build first, then run only while holding the token:

```sh
CANOPY_DESKTOP_TOKEN='<explicitly granted token>' CANOPY_ELECTRON_PATH='<Electron executable>' node tools/perf-desktop.mjs
```

The build supplies `dist/performance-main.cjs`. The audit stages the built production renderer in a disposable directory and uses real provider code with fake transports for three Jira roots and then three GitHub roots. It writes actual launch/load wall time, filter-through-paint wall time, request counts, rendered rows, scroll frame intervals, long tasks, keyboard identity and process memory to `/tmp/canopy-perf-90-desktop.json`. It deletes sample profiles afterward. The script is prepared and statically checked; it has not been executed or validated against a desktop.

Acceptance still requires reviewing the collected evidence and checking all root shapes, collapsed and expanded trees, multiple windows sizes, reading sizes/spacings, tab and subtree navigation, selection and keyboard focus, scroll restoration, hidden Done, filtering, natural sorting, ordinary rank drag and keyboard ranking, linked rows, and open editors during progressive refresh. Run the existing ordinary-navigation/edit/rank smoke checks under the same token. Confirm initial and refresh cancellation, cooldown recovery, offline retention, snapshot release notices, and unread coverage in both tree and saved-view UI. The read-only performance fixture does not emulate writable provider workflows. If actual scroll/render timing demonstrates a bottleneck, virtualization remains follow-up implementation work before declaring full issue acceptance.

The candidate includes main’s issue #83 sidebar organization at `af0808d`. Issue #84 triage/unread and issue #86 relationship branches remain unmerged and will need integration review after they land.
