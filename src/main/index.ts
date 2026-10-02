import { app } from 'electron';
import { launchHandoffArguments } from './work-handoff';
import { launch } from './app';
import { createDemoFixture } from './demo';

const demo = process.argv[app.isPackaged ? 1 : 2] === '--canopy-demo';
launch(
  demo ? createDemoFixture : undefined,
  demo,
  launchHandoffArguments(process.argv, app.isPackaged, process.platform),
);
