import { launch } from './app';
import { createDemoFixture } from './demo';

const demo = process.argv.includes('--canopy-demo');
launch(demo ? createDemoFixture : undefined, demo);
