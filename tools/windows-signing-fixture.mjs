// Synthetic records only; never native or cloud qualification evidence.
export const fixturePolicy = {
  service: 'Microsoft Artifact Signing',
  profileType: 'PublicTrust',
  auth: 'EnvironmentCredential',
  endpoint: 'https://eus.codesigning.azure.net',
  account: 'fixture-account',
  profile: 'fixture-profile',
  profileEku: '1.3.6.1.4.1.311.97.990309390.766961637.194916062.941502583',
  subject: 'CN=Fixture publisher',
  tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  clientId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
};
export const fixtureEnv = {
  CANOPY_WINDOWS_SIGN: '1',
  GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'github-hosted',
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REF: 'refs/tags/v0.1.0',
  GITHUB_REPOSITORY: 'vinnyputty/canopy',
  GITHUB_WORKFLOW_REF:
    'vinnyputty/canopy/.github/workflows/ci.yml@refs/tags/v0.1.0',
  GITHUB_SHA: 'a'.repeat(40),
  CANOPY_WINDOWS_POLICY: JSON.stringify(fixturePolicy),
  AZURE_TENANT_ID: fixturePolicy.tenantId,
  AZURE_CLIENT_ID: fixturePolicy.clientId,
  AZURE_CLIENT_SECRET: 'synthetic-not-a-credential',
  CANOPY_SIGNTOOL: 'fixture-signtool',
  CANOPY_SIGN_DLIB: 'fixture-dlib',
};
export const fixtureSignature = (sha256, thumbprint = 'A'.repeat(40)) => ({
  status: 'Valid',
  subject: fixturePolicy.subject,
  thumbprint,
  timestamp: true,
  revocation: 'online',
  notBefore: '2020-01-01T00:00:00Z',
  notAfter: '2099-01-01T00:00:00Z',
  verifiedAt: '2026-01-01T00:00:00Z',
  timestampNotBefore: '2020-01-01T00:00:00Z',
  timestampNotAfter: '2099-01-01T00:00:00Z',
  timestampThumbprint: 'C'.repeat(40),
  timestampRootSha256:
    '5367F20C7ADE0E2BCA790915056D086B720C33C1FA2A2661ACF787E3292E1270',
  rootSha256:
    '5367F20C7ADE0E2BCA790915056D086B720C33C1FA2A2661ACF787E3292E1270',
  ekus: [
    '1.3.6.1.5.5.7.3.3',
    '1.3.6.1.4.1.311.97.1.0',
    fixturePolicy.profileEku,
  ],
  sha256,
});
