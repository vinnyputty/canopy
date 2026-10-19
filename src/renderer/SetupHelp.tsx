import React, { useState } from 'react';

export function TokenPermissions({
  provider,
}: {
  provider: 'jira' | 'github';
}) {
  const [error, setError] = useState('');
  const open = async (url: string) => {
    try {
      await window.canopy.openLink(url);
    } catch {
      setError(
        'Could not open the browser. Open the provider’s token settings manually.',
      );
    }
  };
  return (
    <div className="setup-permissions">
      {provider === 'github' ? (
        <>
          <p>
            Create a fine-grained token. Choose the resource owner, select your
            repositories, and grant <b>Issues: Read and write</b>. Organization
            approval may be required. Use one owner per connection.
          </p>
          <button
            className="secondary"
            onClick={() =>
              void open(
                'https://github.com/settings/personal-access-tokens/new',
              )
            }
          >
            Create GitHub token
          </button>
          <p>
            Verification checks your account and issue reads in every selected
            repository. It does not perform a write; read-only tokens may verify
            but cannot edit issues.
          </p>
        </>
      ) : (
        <>
          <p>
            Create an Atlassian API token using the same account email. Match
            the Scoped or Classic option to your token.
          </p>
          <p>
            For scoped tokens, choose <code>read:jira-work</code>,{' '}
            <code>write:jira-work</code>, and <code>read:jira-user</code> where
            offered. Ranking also needs <code>write:issue:jira-software</code>;
            granular ranking checks need <code>read:permission:jira</code>. Your
            Jira project permissions still apply.
          </p>
          <button
            className="secondary"
            onClick={() =>
              void open(
                'https://id.atlassian.com/manage-profile/security/api-tokens',
              )
            }
          >
            Create Atlassian token
          </button>
          <p>
            Verification checks your account with /myself. Opening a root checks
            issue access; verification does not prove every edit or rank
            permission.
          </p>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

export function SetupHelp({
  onConnect,
  onOpen,
  hasConnections,
}: {
  onConnect: () => void;
  onOpen: () => void;
  hasConnections: boolean;
}) {
  const [report, setReport] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const review = async () => {
    setBusy(true);
    setStatus('');
    setReport('');
    try {
      setReport(await window.canopy.diagnostics());
    } catch {
      setStatus('Could not prepare diagnostics. Close help and retry.');
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    setStatus('');
    try {
      setStatus(
        (await window.canopy.exportDiagnostics(report))
          ? 'Diagnostics saved. Review the file before sharing with support.'
          : 'Export canceled.',
      );
    } catch {
      setStatus(
        'Could not save diagnostics. Review a fresh report and choose a writable folder.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="setup-help">
      <p>
        Connect a provider, verify access, then open your first root. Help opens
        over your workspace; closing it keeps your connections, tabs, and
        position.
      </p>
      <div className="connect-actions">
        <button className="primary" onClick={onConnect}>
          Connect Jira or GitHub
        </button>
        {hasConnections && (
          <button className="secondary" onClick={onOpen}>
            Open a root
          </button>
        )}
      </div>
      <details>
        <summary>Jira token permissions</summary>
        <TokenPermissions provider="jira" />
      </details>
      <details>
        <summary>GitHub token permissions</summary>
        <TokenPermissions provider="github" />
      </details>
      <h3>Recover a connection</h3>
      <dl>
        <dt>Expired or revoked credentials / 401</dt>
        <dd>
          Create a replacement token, then connect the same site and account or
          GitHub owner again. Matching connections retain their workspace. For
          Jira, check the email and token type too.
        </dd>
        <dt>Missing scopes or denied access / 403 or 404</dt>
        <dd>
          Check the permissions above, selected GitHub repositories,
          organization approval or API-token policy, and Jira Browse projects
          permission. A private GitHub repository can return 404 when access is
          denied.
        </dd>
        <dt>Keychain or keyring unavailable</dt>
        <dd>
          Unlock your OS keychain and restart Canopy with the original OS
          account. On Linux, start and unlock a Secret Service keyring (GNOME
          Keyring or KeePassXC); if needed restart with{' '}
          <code>--password-store=gnome-libsecret</code>. Keep a backup of saved
          credentials; do not delete them to retry.
        </dd>
        <dt>Rate limit / 429</dt>
        <dd>
          Wait until the displayed retry time before retrying. Repeated requests
          can extend provider limits. Loaded trees stay available.
        </dd>
        <dt>Offline or timeout</dt>
        <dd>
          Check internet access, VPN, proxy, and firewall. Reconnect to the
          network, then Retry. Keep the workspace open while the provider
          recovers.
        </dd>
      </dl>
      <h3>Diagnostics for support</h3>
      <p>
        Review the exact report before saving a local JSON file. It includes app
        version, OS, credential-storage availability, provider counts, and
        rate-limit times. Tokens, account/site identities, repository names,
        workspace roots, issue content, and raw errors/logs are excluded.
        Nothing is sent to support automatically.
      </p>
      <button
        className="secondary"
        disabled={busy}
        onClick={() => void review()}
      >
        Review diagnostics
      </button>
      {report && (
        <>
          <pre
            className="diagnostics-report"
            tabIndex={0}
            aria-label="Diagnostics report"
          >
            {report}
          </pre>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void save()}
          >
            Save reviewed diagnostics…
          </button>
        </>
      )}
      {status && <p role="status">{status}</p>}
    </div>
  );
}
