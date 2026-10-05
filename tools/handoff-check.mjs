// Manual target; fresh source review and the exclusive native token are required.
import { requireHandoffLifecycle } from './handoff-audit.mjs';
const reviewedHead = requireHandoffLifecycle(process.argv.slice(2));
if (!process.env.CANOPY_APP_PATH || !process.env.CANOPY_ELECTRON_PATH)
  throw new Error('Use the staged handoff_check target.');
const { runHandoffCheck } = await import('./handoff-native.mjs');
await runHandoffCheck({ reviewedHead });
