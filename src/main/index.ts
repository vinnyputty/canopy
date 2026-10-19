import { app } from 'electron';
import { launchArguments } from './work-handoff';
import { launch } from './app';
import { createDemoFixture } from './demo';

const { demo, handoff } = launchArguments(
  process.argv,
  app.isPackaged,
  process.platform,
);
launch(demo ? createDemoFixture : undefined, demo, handoff);
