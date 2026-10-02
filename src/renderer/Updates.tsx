import React, { useEffect, useRef, useState } from 'react';
import type { UpdatePreferences, UpdateState } from '../shared/updates';

export function useUpdates() {
  const [state, setState] = useState<UpdateState>();
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    let active = true;
    const background = () => {
      const turn = generation.current;
      void window.canopy
        .checkUpdates(true)
        .then((value) => {
          if (active && turn === generation.current) setState(value);
        })
        .catch(() => {});
    };
    void window.canopy
      .updateState()
      .then((value) => {
        if (active && generation.current === 0) setState(value);
      })
      .catch(() => {});
    background();
    const timer = window.setInterval(background, 60 * 60 * 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  const run = async (action: () => Promise<UpdateState>, isCheck = false) => {
    const turn = ++generation.current;
    setBusy(true);
    setChecking(isCheck);
    setError('');
    try {
      const value = await action();
      if (turn === generation.current) setState(value);
    } catch {
      if (turn === generation.current)
        setError(
          'Could not save preferences or complete this action. Try again.',
        );
    } finally {
      if (turn === generation.current) {
        setBusy(false);
        setChecking(false);
      }
    }
  };
  return {
    state,
    busy,
    checking,
    error,
    check: () => run(() => window.canopy.checkUpdates(), true),
    preferences: (value: UpdatePreferences) =>
      run(() => window.canopy.updatePreferences(value)),
    dismiss: () => run(() => window.canopy.dismissUpdateNotice()),
    cancel: () =>
      run(async () => {
        await window.canopy.cancelUpdateCheck();
        return window.canopy.updateState();
      }),
    open: () => {
      if (state?.release)
        void window.canopy
          .openRelease(state.release.tag)
          .catch(() =>
            setError('Could not open the official release page. Try again.'),
          );
    },
  };
}
export type UpdateControls = ReturnType<typeof useUpdates>;
export function UpdateSettings({ updates }: { updates: UpdateControls }) {
  const { state, busy, checking, error } = updates;
  return (
    <fieldset className="update-settings">
      <legend>Updates</legend>
      <p>
        Downloads and installation are started by you on the official GitHub
        Release page. Canopy never downloads or installs updates automatically.
      </p>
      {state && (
        <>
          <p>
            Current version: {state.currentVersion} · {state.platform}
            {!state.packaged && ' · Development build'}
          </p>
          <label>
            <input
              type="checkbox"
              checked={state.preferences.notifications}
              disabled={busy && !checking}
              onChange={(event) =>
                updates.preferences({
                  ...state.preferences,
                  notifications: event.target.checked,
                })
              }
            />{' '}
            Quiet update notices (off by default; check at most weekly)
          </label>
          <label>
            <input
              type="checkbox"
              checked={state.preferences.prereleases}
              disabled={busy && !checking}
              onChange={(event) =>
                updates.preferences({
                  ...state.preferences,
                  prereleases: event.target.checked,
                })
              }
            />{' '}
            Include prereleases
          </label>
        </>
      )}
      <p>
        Checks send an unauthenticated request to the public vinnyputty/canopy
        GitHub Releases API. Issue data and connection credentials are never
        sent. Preferences are saved automatically.
      </p>
      <button className="secondary" disabled={busy} onClick={updates.check}>
        {busy ? (checking ? 'Checking…' : 'Saving…') : 'Check for updates'}
      </button>
      {checking && (
        <button className="secondary" onClick={updates.cancel}>
          Cancel check
        </button>
      )}
      <div role="status">
        {error && <p>{error}</p>}
        {state && (
          <>
            <p>{state.message}</p>
            {state.retryAt && (
              <p>Retry after {new Date(state.retryAt).toLocaleString()}.</p>
            )}
            {state.checkedAt && (
              <p>
                {state.stale ? 'Previously checked' : 'Checked'}{' '}
                {new Date(state.checkedAt).toLocaleString()}
                {state.stale &&
                  ' · Saved result; availability has not been reverified.'}
              </p>
            )}
            {state.release && (
              <>
                <p>
                  Compatible release: {state.release.version}
                  {state.release.prerelease && ' (prerelease)'}
                </p>
                <p>{state.release.assets.join(', ')}</p>
                <pre className="release-notes">
                  {state.release.notes || 'No release notes provided.'}
                </pre>
                <button className="secondary" onClick={updates.open}>
                  Open official GitHub Release
                </button>
              </>
            )}
          </>
        )}
      </div>
    </fieldset>
  );
}
export function UpdateNotice({
  updates,
  onDetails,
}: {
  updates: UpdateControls;
  onDetails: () => void;
}) {
  if (
    !updates.state?.notice ||
    !updates.state.release ||
    !updates.state.preferences.notifications
  )
    return null;
  return (
    <div className="update-notice">
      <span>
        Canopy {updates.state.release.version} is available
        {updates.state.release.prerelease && ' (prerelease)'}.
      </span>
      <button className="secondary" onClick={onDetails}>
        View update
      </button>
      <button className="secondary" onClick={updates.dismiss}>
        Dismiss
      </button>
    </div>
  );
}
