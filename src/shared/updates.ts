export type UpdatePreferences = {
  notifications: boolean;
  prereleases: boolean;
};
export type AvailableRelease = {
  tag: string;
  version: string;
  prerelease: boolean;
  notes: string;
  assets: string[];
};
export type UpdateState = {
  preferences: UpdatePreferences;
  currentVersion: string;
  platform: string;
  packaged: boolean;
  message: string;
  release?: AvailableRelease;
  checkedAt?: number;
  stale?: boolean;
  notice?: boolean;
  retryAt?: number;
};
export const DEFAULT_UPDATES: UpdatePreferences = {
  notifications: false,
  prereleases: false,
};
export function validUpdatePreferences(
  value: unknown,
): value is UpdatePreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    typeof input.notifications === 'boolean' &&
    typeof input.prereleases === 'boolean' &&
    Object.keys(input).every((key) =>
      ['notifications', 'prereleases'].includes(key),
    )
  );
}
