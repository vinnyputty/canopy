/** Keep provider response bodies and request URLs out of setup failures. */
export async function verificationError(
  provider: 'Jira' | 'GitHub',
  response: Response,
) {
  const remaining = response.headers.get('x-ratelimit-remaining');
  let secondaryLimit = false;
  if (provider === 'GitHub' && response.status === 403) {
    try {
      secondaryLimit = /rate limit/i.test(
        String((await response.clone().json()).message ?? ''),
      );
    } catch {}
  }
  if (
    response.status === 429 ||
    (response.status === 403 && (remaining === '0' || secondaryLimit))
  ) {
    const retry = response.headers.get('retry-after');
    const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : NaN;
    const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
    const date = retry && !Number.isFinite(seconds) ? Date.parse(retry) : NaN;
    const until = Number.isFinite(seconds)
      ? Date.now() + seconds * 1000
      : Number.isFinite(date)
        ? date
        : reset;
    return new Error(
      `${provider} rate limit reached. ${until > Date.now() ? `Retry after ${new Date(until).toLocaleTimeString()}.` : 'Wait at least one minute before verifying again.'}`,
    );
  }
  if (response.status === 401)
    return new Error(
      `${provider} rejected these credentials (401). The token may be expired, revoked, or incorrect. Create a replacement token and reconnect the same account.${provider === 'Jira' ? ' Check the Atlassian email and Scoped/Classic token type.' : ''}`,
    );
  if (response.status === 403 || response.status === 404)
    return new Error(
      provider === 'GitHub'
        ? `GitHub denied access (${response.status}). Select the correct resource owner and repositories, grant Issues read and write, and ask an organization administrator to approve the token if required. A private repository can return 404 when access is denied.`
        : `Jira denied access (${response.status}). Check token scopes, Jira site access, Browse projects permission, and your organization’s API-token policy.`,
    );
  return new Error(
    `${provider} returned ${response.status} during verification. Retry later; if it persists, review setup help.`,
  );
}

export async function providerFetch(
  ...args: Parameters<typeof fetch>
): Promise<Response> {
  try {
    return await fetch(...args);
  } catch (error) {
    if (
      args[1]?.signal?.aborted &&
      args[1].signal.reason?.name !== 'TimeoutError'
    )
      throw error;
    throw new Error(
      'Could not reach the provider. Check your internet connection, VPN, proxy, and firewall, then retry. A timeout can also mean the provider is temporarily unavailable.',
    );
  }
}
