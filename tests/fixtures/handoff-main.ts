// Manual desktop audit only. The lock loser never enters this profile guard.
import { app } from 'electron';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { launch } from '../../src/main/app';
import { launchHandoffArguments } from '../../src/main/work-handoff';
import { createDemoFixture } from '../../src/main/demo';

launch(
  async () => {
    const directory = process.env.CANOPY_USER_DATA;
    if (
      !directory ||
      !/^canopy-handoff-audit-[\w-]+$/.test(basename(directory)) ||
      dirname(await realpath(directory)) !== (await realpath(tmpdir())) ||
      (await lstat(directory)).isSymbolicLink()
    )
      throw new Error('Use a disposable handoff audit profile.');
    if ((await readdir(directory)).some((name) => /credential/i.test(name)))
      throw new Error('Audit profiles must contain no credentials.');
    const markerPath = join(directory, 'handoff-audit.json');
    const markerStat = await lstat(markerPath);
    if (
      !markerStat.isFile() ||
      markerStat.isSymbolicLink() ||
      markerStat.size > 1024
    )
      throw new Error('Invalid audit marker file.');
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    if (
      marker.kind !== 'canopy-handoff-audit' ||
      !/^[a-f0-9]{40}$/.test(marker.reviewedHead)
    )
      throw new Error('Missing handoff audit marker.');
    const fixture = await createDemoFixture();
    return {
      ...fixture,
      connection: {
        ...fixture.connection,
        provider: 'jira',
        url: 'https://example.invalid',
      },
    };
  },
  true,
  launchHandoffArguments(process.argv, app.isPackaged, process.platform),
);
