const repository = 'https://github.com/vinnyputty/canopy';

export const supportLinks = {
  releases: { label: 'Releases', url: `${repository}/releases` },
  documentation: { label: 'Documentation', url: `${repository}#readme` },
  issues: { label: 'Report an issue', url: `${repository}/issues/new/choose` },
} as const;

export type SupportLink = keyof typeof supportLinks;

export function supportUrl(value: unknown): string {
  if (typeof value !== 'string' || !Object.hasOwn(supportLinks, value))
    throw new Error('Unknown support link.');
  return supportLinks[value as SupportLink].url;
}
