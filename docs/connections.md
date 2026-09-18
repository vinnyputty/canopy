# Jira Cloud connections

Personal API tokens are Canopy's primary authentication method. No Canopy server or OAuth app registration is required for token connections.

1. Create a token from your [Atlassian account security settings](https://id.atlassian.com/manage-profile/security/api-tokens).
2. In Canopy, choose **Connect Jira site** and enter your site origin (for example, `https://your-team.atlassian.net`), Atlassian account email, and token.
3. Select the token type matching how you created it. Scoped tokens use `api.atlassian.com/ex/jira/{cloudId}`. Classic tokens use the site's REST API directly.
4. Canopy verifies the account before saving the connection. Add more connections for other sites or accounts.

For scoped tokens, grant the scopes needed for issue read/write and user lookup. The operations used are issue get/edit, enhanced JQL search, edit metadata, transitions, assignable-user search, `/myself`, bulk issue-permission checks, and Jira Software issue ranking. Prefer classic Jira scopes `read:jira-work`, `write:jira-work`, and `read:jira-user` where the token UI offers them; ranking requires `write:issue:jira-software`. The exact selectable scopes depend on Atlassian's token creation interface. Consult the operation-specific scope lists in the [Jira Platform REST API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/) and [Jira Software rank API](https://developer.atlassian.com/cloud/jira/software/rest/api-group-issue/#api-rest-agile-1-0-issue-rank-put) if your token UI offers granular scopes; ranking availability checks require `read:permission:jira`.

The ability to create a token does not guarantee it may access every site. Your account needs Jira access and appropriate issue permissions, and the organization may restrict API-token access. If verification fails, check token expiration, the email account, token type, scopes, and your organization's policy. Creating a token without scopes still leaves your ordinary Jira permissions and organization policy in force.

An organization administrator can check **Security → User security → Authentication policies** for managed-account API-token controls. External users have separate controls under **Security → User security → External users**. See [Atlassian authentication policies](https://support.atlassian.com/security-and-access-policies/docs/authentication-policy-settings-for-your-organizations/) and [external-user token controls](https://support.atlassian.com/security-and-access-policies/docs/set-api-token-access/).

Disconnecting a site removes its locally stored credentials. Revoke the token in Atlassian account settings to invalidate it everywhere. OAuth remains available as an [optional connection method](oauth.md).

## Linux credential storage

Canopy stores credentials through your desktop keyring. On GNOME and KDE, Electron selects the desktop's normal keyring backend. On other desktops, such as Sway, Canopy checks the session D-Bus for a Secret Service provider and uses it when available. GNOME Keyring and KeePassXC can provide this service.

If Canopy reports that secure credential storage is unavailable, start and unlock a Secret Service keyring in the same desktop session, then restart Canopy. Advanced setups can select Electron's backend explicitly with `--password-store=gnome-libsecret`.
