# Jira Cloud connections

Personal API tokens are Canopy's primary authentication method. No Canopy server or OAuth app registration is required for token connections.

1. Create a token from your [Atlassian account security settings](https://id.atlassian.com/manage-profile/security/api-tokens).
2. In Canopy, choose **Connect Jira or GitHub → Jira** and enter your site origin (for example, `https://your-team.atlassian.net`), Atlassian account email, and token.
3. Select the token type matching how you created it. Scoped tokens use `api.atlassian.com/ex/jira/{cloudId}`. Classic tokens use the site's REST API directly.
4. Canopy verifies the account before saving the connection. Add more connections for other sites or accounts.

For scoped tokens, grant the scopes needed for issue read/write and user lookup. The operations used are issue get/edit, enhanced JQL search, edit metadata, transitions, assignable-user search, `/myself`, bulk issue-permission checks, and Jira Software issue ranking. Prefer classic Jira scopes `read:jira-work`, `write:jira-work`, and `read:jira-user` where the token UI offers them; ranking requires `write:issue:jira-software`. The exact selectable scopes depend on Atlassian's token creation interface. Consult the operation-specific scope lists in the [Jira Platform REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/) and [Jira Software rank API](https://developer.atlassian.com/cloud/jira/software/rest/api-group-issue/#api-rest-agile-1-0-issue-rank-put) if your token UI offers granular scopes; ranking availability checks require `read:permission:jira`.

For preview remote links, granular scoped tokens need `read:issue.remote-link:jira` and `read:status:jira` (or classic `read:jira-work`), plus Browse projects permission for the issue. This documented endpoint exposes remote links, not the complete native Jira Development panel.

The ability to create a token does not guarantee it may access every site. Your account needs Jira access and appropriate issue permissions, and the organization may restrict API-token access. If verification fails, check token expiration, the email account, token type, scopes, and your organization's policy. Creating a token without scopes still leaves your ordinary Jira permissions and organization policy in force.

An organization administrator can check **Security → User security → Authentication policies** for managed-account API-token controls. External users have separate controls under **Security → User security → External users**. See [Atlassian authentication policies](https://support.atlassian.com/security-and-access-policies/docs/authentication-policy-settings-for-your-organizations/) and [external-user token controls](https://support.atlassian.com/security-and-access-policies/docs/set-api-token-access/).

Disconnecting a site removes its locally stored credentials. Revoke the token in Atlassian account settings to invalidate it everywhere. OAuth remains available as an [optional connection method](oauth.md).

## Linux credential storage

Canopy stores credentials through your desktop keyring. On GNOME and KDE, Electron selects the desktop's normal keyring backend. On other desktops, such as Sway, Canopy checks the session D-Bus for a Secret Service provider and uses it when available. GNOME Keyring and KeePassXC can provide this service.

If Canopy reports that secure credential storage is unavailable, start and unlock a Secret Service keyring in the same desktop session, then restart Canopy. Advanced setups can select Electron's backend explicitly with `--password-store=gnome-libsecret`.

## Setup help and diagnostics

The connection dialog shows the path from provider choice and token permissions to **Verify and save**, then **Open first root**. Jira verification checks `/myself`; GitHub verification checks identity and issue reads on every selected repository. Verification performs no writes and cannot prove every issue, editing, or ranking permission. Use a Jira key/browse URL or search; for GitHub choose a repository root or enter `owner/repo#number`. **Later** retains the saved connection for another session. Close, Escape, and backdrop dismissal remain available during verification. Verification continues in the background and may still save a connection; its late result does not reopen setup or navigate the workspace. Reopening setup or Setup help reloads saved connections. **Try demo** remains a separate, local guided workspace.

Open **Setup help** from the sidebar or a workspace error banner to revisit instructions while keeping connections, tabs, filters, and position. Replace expired/revoked credentials by connecting the same Jira site/account or GitHub account/owner again. Keep the same repository selection when replacing a GitHub token to retain access to those roots. Denied access needs token scopes, project/repository permissions, and organization policy or approval checks; GitHub may return 404 for inaccessible private repositories. Unlock the OS keychain and restart under the original OS account for credential-storage failures; preserve a backup of saved credentials. Wait until the displayed rate-limit retry time. For offline/timeouts check the network, VPN, proxy, and firewall, then Retry.

**Review diagnostics** prepares an explicit allowlist report: app version, OS, demo mode, credential-storage availability, provider/repository counts, and connection rate-limit times. The exact JSON appears before **Save reviewed diagnostics…** opens a local save dialog. Canceling leaves the workspace intact. Nothing is sent automatically. Tokens and credentials, account/site identities, repository names, workspace roots, issue titles/descriptions/comments, raw errors, and logs are always excluded. The report deliberately contains no private-content opt-in. Review the saved file before sharing it with support.

Unit tests use isolated mocked provider responses and synthetic credentials. `smoke_github` also runs Electron fixtures for held-verification dismissal through Close/Escape/backdrop, late success/failure isolation, workspace preservation, canonical Jira reconnect and first-root selection, and diagnostics preview/save/cancel/failure. Diagnostics fixtures mock the native save-dialog choices and verify the actual saved bytes; they do not exercise the operating system’s file chooser. These source/UI checks require no live credentials. Guided-demo checks cover replay and return to the original workspace.

Actual encryption/unlock/restart behavior depends on Electron `safeStorage` and the target OS keychain (Secret Service on Linux). Empirical scope and policy acceptance requires an explicitly authorized disposable provider account and token. Native file-chooser interaction remains a separate OS check. Keep these checks pending rather than using real user data.
