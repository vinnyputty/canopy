# Atlassian OAuth broker

Canopy supports this Atlassian OAuth 2.0 (3LO) broker as an optional alternative to its primary API-token sign-in. It is intended for environments that require browser-based SSO. Atlassian requires a client secret when an authorization code is exchanged, so the secret lives in this small broker instead of the desktop application. Sign-in happens in the user's system browser and therefore follows the SSO and authentication policies configured for the Atlassian organization.

The broker keeps pending sign-ins and completed, unclaimed token sets in memory. It never writes or logs access tokens, refresh tokens, authorization codes, or the client secret. Run a single broker process unless session storage is replaced with a shared store.

## Atlassian setup

1. Create an OAuth 2.0 (3LO) integration in the [Atlassian developer console](https://developer.atlassian.com/console/myapps/).
2. Add `https://YOUR_BROKER_ORIGIN/callback` as its callback URL. It must exactly match the public `CANOPY_BROKER_URL` plus `/callback`.
3. Grant these scopes:
   - `read:jira-work`
   - `write:jira-work`
   - `read:jira-user`
   - `offline_access`
   - `write:issue:jira-software`
4. Copy the client ID and client secret into the broker environment.

The Jira platform recommends the classic `read:jira-work`, `write:jira-work`, and `read:jira-user` scopes for the platform operations Canopy uses. `offline_access` requests refresh tokens. Jira Software's rank endpoint requires the granular `write:issue:jira-software` scope. See Atlassian's [OAuth 2.0 (3LO) guide](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/) and [Rank issues API](https://developer.atlassian.com/cloud/jira/software/rest/api-group-issue/#api-rest-agile-1-0-issue-rank-put).

## Run the broker

The Bazel build produces `bazel-bin/dist/broker.cjs`. Configure it with:

```sh
ATLASSIAN_CLIENT_ID=your-client-id \
ATLASSIAN_CLIENT_SECRET=your-client-secret \
CANOPY_BROKER_URL=https://canopy-auth.example.com \
HOST=127.0.0.1 \
PORT=8787 \
bazel run //:broker
```

`ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET`, and `CANOPY_BROKER_URL` are required. `HOST` defaults to `127.0.0.1` and `PORT` defaults to `8787`. `CANOPY_BROKER_URL` must be an HTTPS origin without a path. Plain HTTP is accepted only for `localhost` and loopback development.

Put the broker behind an HTTPS reverse proxy and forward requests to its loopback listener. Apply request and connection limits at that proxy as well as the broker's in-process limits. The proxy must not log request bodies or query strings because refresh tokens and OAuth authorization codes pass through them. Avoid caching every broker route. Restrict environment-secret access to the broker process and rotate the Atlassian client secret if it is exposed.

Set the desktop app's `CANOPY_BROKER_URL` environment variable to the same public origin when launching it. An empty setting disables browser OAuth; API-token connections and demo mode remain available.

## Protocol

The desktop creates a random verifier of 43–128 characters from the unreserved URL alphabet and computes `base64url(SHA-256(verifier))`. It sends only the digest to the broker:

```http
POST /sessions
Content-Type: application/json

{"challenge":"BASE64URL_SHA256_DIGEST"}
```

The response contains a random session ID and an Atlassian authorization URL:

```json
{
  "id": "SESSION_ID",
  "authorizeUrl": "https://auth.atlassian.com/authorize?..."
}
```

Canopy opens `authorizeUrl` in the system browser. Atlassian returns to `/callback`; the broker validates the random state, consumes it once, and exchanges the code using the server-only client secret. The callback displays a fixed success or failure page and never redirects to input supplied by a request.

While the browser flow is active, Canopy polls with the verifier:

```http
GET /sessions/SESSION_ID
Authorization: Bearer VERIFIER
```

The broker returns `202` while authorization is pending. After success it returns the token set exactly once and deletes the session:

```json
{ "accessToken": "...", "refreshToken": "...", "expiresAt": 1700000000000 }
```

Pending sessions expire after ten minutes. A failed exchange returns `502` to the next authenticated poll and consumes the session. Invalid or expired sessions return `404`, while a bad verifier returns `401`.

Canopy stores tokens in the operating system credential store. To refresh, it sends the stored refresh token over HTTPS:

```http
POST /refresh
Content-Type: application/json

{"refreshToken":"..."}
```

The broker uses the client secret to obtain a fresh access token and returns the same token-set shape. Canopy replaces the stored refresh token whenever the response contains a rotated value. Atlassian documents refresh-token rotation and its reuse interval in the [3LO guide](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/#use-a-refresh-token-to-get-another-access-token-and-refresh-token-pair).

After sign-in, the desktop calls Atlassian's [`/oauth/token/accessible-resources`](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/#get-the-cloudid-for-your-site) endpoint with the access token. Each returned `id` identifies a Jira site. Jira API calls then go directly from Canopy to `https://api.atlassian.com/ex/jira/{cloudid}`; issue data does not pass through the broker. A user can repeat the flow to connect additional Atlassian accounts and sites.

`GET /health` returns `{"ok":true}` for deployment health checks. Every endpoint is subject to an in-memory request limit by directly connected address, request bodies are capped at 16 KiB, and responses containing authentication state use `Cache-Control: no-store`.
