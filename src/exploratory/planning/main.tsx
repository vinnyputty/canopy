import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { TreeFilters } from '../../shared/types';
import { dates, relationships, snapshot } from './fixture';
import { fixtureMilestones, planningGraph } from './model';
import './style.css';

const savedFilters: {
  name: string;
  filters: TreeFilters;
  hideDone: boolean;
}[] = [
  { name: 'All work', filters: {}, hideDone: false },
  { name: 'Open work', filters: {}, hideDone: true },
  {
    name: 'Done work (with ancestors)',
    filters: { status: 'done' },
    hideDone: false,
  },
];
function Prototype() {
  const [saved, setSaved] = useState(0);
  const [view, setView] = useState('tree');
  const [selected, setSelected] = useState('PLAN-1');
  const [syntheticDates, setSyntheticDates] = useState(false);
  const filter = savedFilters[saved];
  const graph = planningGraph(
    snapshot,
    relationships,
    filter.filters,
    filter.hideDone,
  );
  const visible = new Set(graph.nodes.keys());
  const selectedIssue = graph.nodes.get(selected)?.issue;
  const milestones = fixtureMilestones(syntheticDates ? dates : [], visible);
  const keys = [
    ...new Set([
      ...visible,
      ...graph.edges.flatMap((edge) => [edge.from, edge.to]),
    ]),
  ];
  const positions = new Map(
    keys.map((key, index) => [
      key,
      { x: 85 + (index % 3) * 220, y: 60 + Math.floor(index / 3) * 100 },
    ]),
  );
  const issueButton = (key: string) =>
    visible.has(key) ? (
      <button aria-pressed={selected === key} onClick={() => setSelected(key)}>
        {key}
      </button>
    ) : (
      <span>{key} (outside saved filter or unavailable)</span>
    );
  return (
    <main>
      <h1>Planning view experiment</h1>
      <p>
        Standalone synthetic fixture for issue #91. All issues, links and dates
        below are invented. Selection and saved filters are shared between
        views. Nothing connects to a provider.
      </p>
      <label>
        Fixture saved filter{' '}
        <select
          value={saved}
          onChange={(event) => setSaved(Number(event.target.value))}
        >
          {savedFilters.map((item, index) => (
            <option value={index} key={item.name}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <nav aria-label="Planning views">
        {['tree', 'graph', 'milestones'].map((name) => (
          <button
            key={name}
            aria-pressed={view === name}
            onClick={() => setView(name)}
          >
            {name}
          </button>
        ))}
      </nav>
      <p role="status">
        {visible.size} visible issues including ancestor context.{' '}
        {selectedIssue
          ? `Selected ${selected}: ${selectedIssue.summary}`
          : `${selected} is outside this filter. Choose a visible issue.`}
      </p>
      {view === 'tree' && (
        <section aria-label="Existing tree comparison">
          <h2>Tree</h2>
          <ul>
            {[...graph.nodes.values()].map((node) => (
              <li
                key={node.issue.key}
                className={node.issue.parentKey ? 'child' : ''}
              >
                {issueButton(node.issue.key)} {node.issue.summary} ·{' '}
                {node.issue.status.name}
              </li>
            ))}
          </ul>
        </section>
      )}
      {view === 'graph' && (
        <section>
          <h2>Dependency graph</h2>
          <p>
            Arrow: blocker → blocked issue; parent → child. Blue solid =
            blocker; gray dashed = hierarchy; purple dotted = ordinary link
            (without directional meaning). Red = confirmed cycle. Unknown
            endpoints have dashed borders. Missing coverage appears below;
            absence of a line does not prove independence.
          </p>
          <svg
            viewBox={`0 0 660 ${Math.ceil(keys.length / 3) * 100 + 30}`}
            role="img"
            aria-label="Relationship diagram. Equivalent issue and edge controls follow below."
          >
            <defs>
              <marker
                id="arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
              </marker>
            </defs>
            {graph.edges.map((edge, index) => {
              const a = positions.get(edge.from)!;
              const b = positions.get(edge.to)!;
              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const inset = Math.min(65 / Math.abs(dx), 19 / Math.abs(dy));
              return (
                <line
                  key={index}
                  x1={a.x + dx * inset}
                  y1={a.y + dy * inset}
                  x2={b.x - dx * inset}
                  y2={b.y - dy * inset}
                  className={`${edge.kind} ${edge.cycle ? 'cycle' : ''}`}
                  markerEnd={
                    edge.kind === 'related' ? undefined : 'url(#arrow)'
                  }
                />
              );
            })}
            {keys.map((key) => {
              const point = positions.get(key)!;
              return (
                <g key={key}>
                  <rect
                    x={point.x - 65}
                    y={point.y - 19}
                    width="130"
                    height="38"
                    className={visible.has(key) ? '' : 'unknown'}
                  />
                  <text x={point.x} y={point.y + 5} textAnchor="middle">
                    {key}
                  </text>
                </g>
              );
            })}
          </svg>
          <h3>Issues</h3>
          <ul>
            {keys.map((key) => (
              <li key={key}>{issueButton(key)}</li>
            ))}
          </ul>
          <h3>Edges</h3>
          <ul>
            {graph.edges.map((edge, index) => (
              <li key={index}>
                {edge.from}{' '}
                {edge.kind === 'blocker'
                  ? 'blocks'
                  : edge.kind === 'hierarchy'
                    ? 'is parent of'
                    : 'relates to'}{' '}
                {edge.to}
                {edge.cycle ? ' · cycle' : ''}
                {edge.unknown ? ' · endpoint filtered or access unknown' : ''}
              </li>
            ))}
          </ul>
          <h3>Unknown coverage</h3>
          {graph.unknown.length ? (
            <ul>
              {graph.unknown.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
          ) : (
            <p>No unknown groups in this fixture scope.</p>
          )}
        </section>
      )}
      {view === 'milestones' && (
        <section>
          <h2>Milestones</h2>
          <p>
            Current Jira and GitHub adapters expose created/updated timestamps,
            and GitHub milestone titles, but no reliable scheduling dates. Those
            fields are not deadlines. Real provider mode therefore has no
            entries.
          </p>
          <label>
            <input
              type="checkbox"
              checked={syntheticDates}
              onChange={(event) => setSyntheticDates(event.target.checked)}
            />{' '}
            Show explicitly reliable synthetic fixture dates
          </label>
          {milestones.length ? (
            <ol>
              {milestones.map((item) => (
                <li key={item.key}>
                  <time dateTime={item.date}>{item.date}</time> ·{' '}
                  {issueButton(item.key)} · fixture {item.field}
                </li>
              ))}
            </ol>
          ) : (
            <p>No reliable planning dates available.</p>
          )}
          <p>
            {visible.size - new Set(milestones.map((item) => item.key)).size}{' '}
            visible issues have no accepted planning date. Undated work is not
            scheduled automatically.
          </p>
        </section>
      )}
      <aside aria-label="Selected issue">
        <h2>Same issue</h2>
        {selectedIssue ? (
          <>
            <p>
              {selectedIssue.key}: {selectedIssue.summary} ·{' '}
              {selectedIssue.status.name}
            </p>
            <button onClick={() => setView('tree')}>
              Return to {selectedIssue.key} in tree
            </button>
          </>
        ) : (
          <p>
            The saved filter excludes the selected issue. Selection is retained
            until you change it.
          </p>
        )}
      </aside>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Prototype />);
