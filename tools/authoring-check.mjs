import * as lifecycle from './audit-lifecycle.mjs';
import { auditAuthoring } from './smoke-authoring.mjs';
import { resolve } from 'node:path';

// The serialized native runner supplies its verified staged bundle and runtime.
const appPath = process.env.CANOPY_APP_PATH;
const executablePath = process.env.CANOPY_ELECTRON_PATH;
if (!appPath || !executablePath)
  throw new Error(
    'Authoring audit requires CANOPY_APP_PATH and CANOPY_ELECTRON_PATH',
  );
await auditAuthoring(
  resolve(appPath),
  resolve(executablePath),
  process.env,
  lifecycle,
);
