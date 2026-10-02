import type {
  Issue,
  IssueRelationships,
  RelationshipGroup,
  RelationshipKind,
} from './types';

export const relationshipKinds: RelationshipKind[] = [
  'blockers',
  'blocked',
  'related',
  'parent',
  'children',
];
export const relationshipTitles: Record<RelationshipKind, string> = {
  blockers: 'Blockers',
  blocked: 'Blocked issues',
  related: 'Related links',
  parent: 'Parent path',
  children: 'Child paths',
};
export function linkKind(link: Issue['links'][number]): RelationshipKind {
  if (/^(?:is )?blocked by$/i.test(link.relationship.trim())) return 'blockers';
  if (/^blocks$/i.test(link.relationship.trim())) return 'blocked';
  return 'related';
}
export function issueRelationships(issue: Issue): IssueRelationships {
  return {
    key: issue.key,
    groups: relationshipKinds.map((kind): RelationshipGroup => ({
      kind,
      state:
        kind === 'parent' ||
        kind === 'children' ||
        issue.linksAvailable !== true
          ? 'unavailable'
          : 'visible',
      reason:
        kind === 'parent' || kind === 'children'
          ? 'Hierarchy has not been loaded.'
          : issue.linksAvailable !== true
            ? 'Link data is unavailable; blocker state is unknown.'
            : undefined,
      items:
        kind === 'parent' || kind === 'children'
          ? []
          : issue.links
              .filter((link) => linkKind(link) === kind)
              .map((link) => ({
                ...link,
                direction:
                  link.direction ??
                  (kind === 'blockers' ? 'inward' : 'outward'),
                access: link.statusCategory ? 'available' : 'unknown',
              })),
    })),
  };
}
/** Provider errors can contain response bodies or private URLs. Return only fixed descriptions. */
export function relationshipFailure(
  error: unknown,
  signal?: AbortSignal,
): Pick<RelationshipGroup, 'problem' | 'reason'> {
  if (signal?.aborted)
    return { problem: 'cancelled', reason: 'Relationship request cancelled.' };
  const message = error instanceof Error ? error.message : '';
  if (/401|403|404|410|forbidden|permission|unauthorized/i.test(message))
    return {
      problem: 'inaccessible',
      reason:
        'Relationships are inaccessible, missing, or unavailable to this connection. Blocker state is unknown.',
    };
  return {
    problem: 'error',
    reason:
      'Relationships could not be loaded. Retry to inspect this part of the graph.',
  };
}
