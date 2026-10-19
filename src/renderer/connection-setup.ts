import type { Connection } from '../shared/types';

/** Token verification appends the saved account; match its canonical identity. */
export function verifiedSetupConnection(
  value: Connection[],
  previous: Connection[],
  input: {
    provider: 'jira' | 'github';
    siteUrl: string;
    repositories: string;
    oauth?: boolean;
  },
): Connection | undefined {
  if (input.oauth)
    return value.find((item) => !previous.some((old) => old.id === item.id));
  if (input.provider === 'github') {
    const repository = input.repositories
      .split(/[\s,]+/)
      .filter(Boolean)[0]
      ?.toLowerCase();
    return [...value]
      .reverse()
      .find(
        (item) =>
          item.provider === 'github' && item.repositories?.includes(repository),
      );
  }
  let origin: string;
  try {
    origin = new URL(input.siteUrl.trim()).origin;
  } catch {
    return undefined;
  }
  return [...value]
    .reverse()
    .find((item) => item.id.startsWith('token:') && item.url === origin);
}

/** Dismissal and unmount suppress every UI callback from an outstanding attempt. */
export async function runSetupVerification<T>(
  verify: () => Promise<T>,
  callbacks: {
    isOpen: () => boolean;
    success: (value: T) => void;
    failure: (reason: unknown) => void;
    settled: () => void;
  },
) {
  try {
    const value = await verify();
    if (callbacks.isOpen()) callbacks.success(value);
  } catch (reason) {
    if (callbacks.isOpen()) callbacks.failure(reason);
  } finally {
    if (callbacks.isOpen()) callbacks.settled();
  }
}
