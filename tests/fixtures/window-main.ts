import { app } from 'electron';
import { Storage } from '../../src/main/storage';

// This entry point exists only in the window acceptance bundle. Count calls to
// the real disk queue; the harness can write disposable sample records through
// that same instance without contacting providers or using an OS keychain.
const controls = {
  storage: null as Storage | null,
  writes: [] as { name: string; value: unknown; failed: boolean }[],
  events: { move: 0, moved: 0, resize: 0 },
};
Object.assign(globalThis, { canopyWindowTest: controls });
const write = Storage.prototype.write;
Storage.prototype.write = function (name, value) {
  controls.storage = this;
  const record = { name, value: structuredClone(value), failed: false };
  controls.writes.push(record);
  return write.call(this, name, value).catch((error) => {
    record.failed = true;
    throw error;
  });
};
app.on('browser-window-created', (_event, window) => {
  window.on('move', () => controls.events.move++);
  window.on('moved', () => controls.events.moved++);
  window.on('resize', () => controls.events.resize++);
});

// Install instrumentation before main creates the local controlled provider.
void import('./main');
