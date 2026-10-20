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
      <p className="settings-intro">Make this workspace comfortable for you.</p>
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
          Reset reading to Medium / Comfortable
        </button>
        <p>
          Root View controls keep columns, sorting, and filters separate.
          Resetting a root keeps these reading settings.
        </p>
      </fieldset>
      <fieldset>
        <legend>Appearance</legend>
        <p>
          Preview theme and palette changes, then Save to keep them. Cancel
          restores your saved appearance.
        </p>
        <button className="secondary" onClick={onAppearance}>
          Appearance
        </button>
      </fieldset>
      <fieldset className="settings-resources">
        <legend>Workspace and help</legend>
        <div>
          <button className="secondary" onClick={onConnect}>
            Connection setup
          </button>
          <p>
            Connect Jira or GitHub, check token permissions, or recover access.
          </p>
        </div>
        <div>
          <button className="secondary" onClick={onShortcuts}>
            Keyboard shortcuts
          </button>
          <p>Browse shortcuts, customize keys, or restore defaults.</p>
        </div>
        <div>
          <button className="secondary" onClick={onBackup}>
            Workspace backup and transfer
          </button>
          <p>
            Review metadata before exporting or importing. Credentials stay on
            this machine.
          </p>
        </div>
      </fieldset>
      {updates}
    </div>
  );
}
