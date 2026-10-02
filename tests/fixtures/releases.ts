import { releaseUrl, RELEASE_ORIGIN } from '../../src/main/releases';
export function release(version = '0.2.0', suffix = 'mac-arm64.dmg') {
  const tag = `v${version}`,
    name = `Canopy-${version}-${suffix}`;
  return {
    tag_name: tag,
    html_url: releaseUrl(tag),
    draft: false,
    prerelease: false,
    published_at: '2026-10-01T00:00:00Z',
    body: '<script>sample notes</script>',
    assets: [
      {
        name,
        state: 'uploaded',
        size: 100,
        browser_download_url: `${RELEASE_ORIGIN}/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
      },
    ],
  };
}
