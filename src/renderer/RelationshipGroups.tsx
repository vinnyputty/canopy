import React from 'react';
import type { IssueRelationships } from '../shared/types';
import { relationshipTitles } from '../shared/relationships';

export function RelationshipGroups({
  graph,
  identity,
  onPreview,
  onJump,
}: {
  graph: IssueRelationships;
  identity: string;
  onPreview: (key: string) => void;
  onJump: (key: string) => void;
}) {
  return (
    <div className="relationship-groups">
      <p className="preview-hint">
        {identity} · Relationships from {graph.key}. Only issues visible to this
        connection are returned; inaccessible issues may be omitted by the
        provider.
      </p>
      {graph.groups.map((group) => (
        <section key={group.kind} aria-label={relationshipTitles[group.kind]}>
          <h4>
            {relationshipTitles[group.kind]} ·{' '}
            {group.state === 'visible' ? 'Visible results' : group.state}
          </h4>
          {group.reason && (
            <p role={group.problem ? 'status' : undefined}>{group.reason}</p>
          )}
          {group.items.length === 0 && group.state === 'visible' && (
            <p>
              No visible {relationshipTitles[group.kind].toLowerCase()}{' '}
              returned.
            </p>
          )}
          {group.items.map((link, index) => (
            <article className="preview-link" key={`${link.key}-${index}`}>
              <strong>
                {graph.key} {link.relationship} {link.key}
              </strong>
              <p className="preview-hint">
                {identity} ·{' '}
                {link.direction === 'inward' ? 'Incoming' : 'Outgoing'}
                {group.kind === 'related' ? ' related link' : ''}
                {link.crossRepository ? ' · Cross-repository' : ''} ·{' '}
                {link.statusCategory === 'done'
                  ? 'Completed'
                  : link.statusCategory
                    ? 'Active'
                    : 'Status unknown'}
              </p>
              <p>{link.summary}</p>
              {link.access === 'outside-connection' ? (
                <p>
                  Outside this connection’s selected repositories. Add the
                  repository to inspect this issue.
                </p>
              ) : (
                <div>
                  {link.access === 'unknown' && (
                    <p>Target access and status have not been verified.</p>
                  )}
                  <button
                    className="text-button"
                    onClick={() => onPreview(link.key)}
                  >
                    Preview {link.key}
                  </button>{' '}
                  <button
                    className="tool-button"
                    onClick={() => onJump(link.key)}
                  >
                    Show {link.key} in tree
                  </button>
                </div>
              )}
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}
