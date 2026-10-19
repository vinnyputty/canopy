# Planning views experiment (#91)

Run `node tools/planning-prototype.mjs`, then open `dist/planning-prototype/index.html` in a browser. This standalone page uses invented issues and links, runs without Electron, credentials or network calls, and does not alter the released desktop UI. It is a small evaluation surface, not a production planner.

The graph uses the current `IssueRelationships` group meanings: blocker → blocked, parent → child, and ordinary links without directional meaning. Confirmed directed cycles are marked separately for dependency and hierarchy edges; incomplete endpoints cannot establish a cycle. Unknown group coverage is listed even if no edge is available. Filtered or inaccessible endpoints remain labeled boundary nodes, without selectable issue details. The small fixed layout is deliberately limited to this fixture; it is not evidence of readability at scale.

Tree, graph and milestones share selection and the same fixture saved filters. `filterTree` supplies their visible issue set, including ancestor context. Returning to the tree retains the same selected issue. A selection excluded by a filter remains explicit until the user chooses another issue. These preset filters exercise the existing `TreeFilters` shape; this page does not read or write the user's desktop saved views.

## Provider evidence and dates

Inspection of `src/shared/types.ts`, `src/main/jira.ts` and `src/main/github.ts` at the branch base found no scheduling date in `Issue`. Jira preview maps created/updated timestamps. GitHub preview maps created/updated timestamps and a milestone **title**, without its due date. Updated/created timestamps describe activity, not a schedule. A title alone does not provide a milestone date. Therefore the default milestone view has no dates. No provider scheduling fields or date inference are added.

An explicit checkbox enables synthetic date-only fixture evidence. Its gate requires a declared reliable date, fixture provenance, calendar validity and membership in the same visible issue set. The security review's unreliable date is omitted. Real provider integration would first need verified field availability, semantics, permissions and missing-date behavior; this fixture gate is not a production adapter contract. All visible issues without accepted dates are counted as undated.

## Evaluation worksheet

Use each view with the same filter and record accuracy, time to answer and whether switching back to the same issue was clear. These tasks have fixture answers for checking the interaction; a meaningful value decision still requires the user's own planning question and representative real work.

| Question                                                                  | Fixture answer                                                                                        | Expected useful view                                                               | User observation |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------- |
| Why can API and interface work not advance independently?                 | PLAN-2 and PLAN-3 block each other; confirmed cycle.                                                  | Graph exposes the reciprocal dependency absent from tree rows.                     | Pending          |
| Can security review safely proceed?                                       | EXT-1 is an unknown blocker endpoint; coverage cannot establish readiness.                            | Graph shows boundary and uncertainty together.                                     | Pending          |
| Which work belongs under release?                                         | PLAN-2 through PLAN-6 are children of PLAN-1.                                                         | Tree already answers this directly.                                                | Pending          |
| What is due before rollout, and what remains undated?                     | Fixture API Nov 3, guide Nov 4, interface Nov 5, rollout Nov 10; release and security review undated. | Milestones orders accepted dates; needs real reliable dates to help real planning. | Pending          |
| Does open-work filtering change interpretation?                           | Guide is filtered; related endpoint remains labeled outside filter.                                   | Compare tree and graph without changing the filter.                                | Pending          |
| With Done work selected, can a dated issue return to the same tree issue? | Select PLAN-5 in milestones, then Return to PLAN-5 in tree; PLAN-1 remains ancestor context.          | All views share selection.                                                         | Pending          |

The fixture demonstrates representational differences, not validated user benefit. Automated checks cover cycle separation, incomplete edges, filter boundaries and reliable date acceptance. Production graph/timeline work and closing the value acceptance criterion remain pending until the user records a real question that is answered more accurately or quickly than the existing tree. If tree is equally effective, retain the tree. The milestone view currently cannot answer real scheduling questions with Canopy's mapped provider data.
