import React from 'react';
import type { ReadingSettings } from '../shared/types';
import { DEFAULT_READING } from '../shared/views';

export function Settings({
  updates,
  reading,
  onReading,
  onAppearance,
  onShortcuts,
  onConnect,
  onBackup,
}: {
  updates?: React.ReactNode;
  reading: ReadingSettings;
  onReading: (reading: ReadingSettings) => void;
  onAppearance: () => void;
  onShortcuts: () => void;
  onConnect: () => void;
  onBackup: () => void;
}) {
  return (
    <div className="settings-content">
      {updates}
      <fieldset>
        <legend>Reading</legend>
        <p>
          Applies immediately to every issue tree and saved view. Saved
          automatically.
        </p>
        <label>
          Text size{' '}
          <select
            aria-label="Text size"
            value={reading.textSize}
            onChange={(event) =>
              onReading({
                ...reading,
                textSize: event.target.value as ReadingSettings['textSize'],
              })
            }
          >
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
          </select>
        </label>
        <label>
          Row spacing{' '}
          <select
            aria-label="Row spacing"
            value={reading.spacing}
            onChange={(event) =>
              onReading({
                ...reading,
                spacing: event.target.value as ReadingSettings['spacing'],
              })
            }
          >
            <option value="compact">Compact</option>
            <option value="comfortable">Comfortable</option>
          </select>
        </label>
        <button
          className="secondary"
          onClick={() => onReading({ ...DEFAULT_READING })}
        >
          Reset reading to Medium / Compact
        </button>
        <p>
          Root View controls keep columns, sorting, and filters separate.
          Resetting a root keeps these reading settings.
        </p>
      </fieldset>
      <button className="secondary" onClick={onAppearance}>
        Appearance
      </button>
      <button className="secondary" onClick={onShortcuts}>
        Keyboard shortcuts
      </button>
      <button className="secondary" onClick={onConnect}>
        Connection setup
      </button>
      <button className="secondary" onClick={onBackup}>
        Workspace backup and transfer
      </button>
      <p>
        Appearance resets to System / Default before saving. Keyboard shortcuts
        can restore defaults. Connections are managed in the sidebar; reading
        reset keeps connections and credentials.
      </p>
    </div>
  );
}
