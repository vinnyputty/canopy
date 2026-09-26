import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditGithub } from './smoke-github.mjs';

const userData = await mkdtemp(join(tmpdir(), 'canopy-github-smoke-'));
const env = { ...process.env, CANOPY_USER_DATA: userData };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({
    executablePath: process.env.CANOPY_ELECTRON_PATH,
    args: [process.env.CANOPY_APP_PATH],
    env,
  });
  const page = await app.firstWindow();
  await expect(
    page.getByRole('heading', { name: 'See the whole tree.' }),
  ).toBeVisible();
  await auditGithub(app, page);
} finally {
  await app?.close();
  await rm(userData, { recursive: true, force: true });
}
