import React from 'react';
import type { RefreshAnnouncement } from './refresh';

// One unkeyed consumer survives tree/saved-view navigation. Only its owner speaks.
export function RefreshStatus({
  message,
  owner,
  scope,
}: {
  message: RefreshAnnouncement | null;
  owner: string | null;
  scope: number;
}) {
  return (
    <span
      id="refresh-status"
      className="sr-only"
      role="status"
      aria-atomic="true"
    >
      {message?.tabId === owner && message?.scope === scope ? message.text : ''}
    </span>
  );
}
