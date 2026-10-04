const diagnosticString = (error) => {
  try {
    return String(error?.message ?? error).slice(0, 500);
  } catch {
    return 'Diagnostic value could not be formatted';
  }
};

/** Adapter only: ownership, deadlines and reaping belong to the shared helper. */
export function authoringAuditLifecycle(lifecycle) {
  if (
    !lifecycle ||
    typeof lifecycle.AuditOwner !== 'function' ||
    typeof lifecycle.deadline !== 'function' ||
    typeof lifecycle.finishAudit !== 'function'
  )
    throw new Error(
      'Authoring restart acceptance is blocked: integrate the reviewed, platform-qualified shared AuditOwner/deadline/finishAudit helper before native execution.',
    );
  return ({ profile, executable, report = console.log }) => {
    let owner;
    let closeAttempted = false;
    let stage = 'created';
    const reportErrors = [];
    const pending = new Set();
    let retained = false;
    let phase;
    let evidence = [];
    const listeners = [];
    const detach = () => {
      for (const [target, event, listener] of listeners.splice(0))
        target.removeListener?.(event, listener);
    };
    const observe = (target, event, source, describe) => {
      if (!target?.on) return;
      const listener = (...args) => {
        let message;
        try {
          message = diagnosticString(describe(...args));
        } catch (error) {
          message = diagnosticString(error);
        }
        evidence.push({ source, message });
        if (evidence.length > 40) evidence.shift();
      };
      target.on(event, listener);
      listeners.push([target, event, listener]);
    };
    const record = (status, fields = {}) => {
      try {
        report(
          JSON.stringify({ audit: 'authoring', stage, status, ...fields }),
        );
      } catch (error) {
        reportErrors.push(error);
      }
    };
    const run = async (label, operation) => {
      stage = label;
      const started = Date.now();
      record('start');
      try {
        const value = await lifecycle.deadline(
          () => {
            const original = Promise.resolve().then(operation);
            pending.add(original);
            return original.finally(() => pending.delete(original));
          },
          30_000,
          label,
        );
        stage = label;
        record('done', { elapsedMs: Date.now() - started });
        return value;
      } catch (error) {
        if (pending.size) retained = true;
        stage = label;
        record('failed', {
          elapsedMs: Date.now() - started,
          message: diagnosticString(error),
        });
        throw error;
      }
    };
    return {
      run,
      async launch(launchPhase, operation) {
        if (owner) throw new Error('Previous authoring scope is not closed');
        detach();
        evidence = [];
        // Evidence belongs to this launch, including a failed launch.
        phase = launchPhase;
        owner = new lifecycle.AuditOwner({ profile, executable });
        closeAttempted = false;
        const app = await run(`${phase}:launch`, () => owner.launch(operation));
        // Retain/confirm the real ChildProcess, never a bare PID.
        owner.confirm(app.process());
        const child = app.process();
        observe(child.stdout, 'data', 'main stdout', (chunk) => chunk);
        observe(child.stderr, 'data', 'main stderr', (chunk) => chunk);
        observe(child, 'exit', 'main exit', (code, signal) =>
          JSON.stringify({ code, signal }),
        );
        return app;
      },
      observePage(page) {
        observe(page, 'pageerror', 'page error', (error) => error);
        observe(page, 'framenavigated', 'navigation', (frame) => frame.url());
        observe(page, 'crash', 'page crash', () => 'Renderer crashed');
        observe(page, 'close', 'page close', () => 'Page closed');
      },
      async closeForRestart(app) {
        stage = 'restart:close-owned-scope';
        record('start');
        closeAttempted = true;
        const result = await owner.shutdown(() => app.close());
        if (
          !result.terminated ||
          result.errors.length ||
          retained ||
          pending.size
        )
          throw new AggregateError(
            result.errors,
            'Authoring restart refused: previous owned scope did not close cleanly',
            { cause: result.errors[0] },
          );
        record('done');
        owner = undefined;
        detach();
      },
      failure(error) {
        record('primary', {
          message: diagnosticString(error),
          exitCode: owner?.child?.exitCode ?? null,
          signalCode: owner?.child?.signalCode ?? null,
          phase,
          pid: owner?.child?.pid ?? null,
          evidence: [...evidence],
        });
      },
      async finish({
        app,
        primary,
        primaryFailed = primary !== undefined,
        removeProfile,
      }) {
        // Failed launch ownership is still owned by the shared helper. A timed
        // out close is not repeated; settlement and scope absence gate removal.
        await lifecycle
          .finishAudit({
            owner,
            close: app && !closeAttempted ? () => app.close() : undefined,
            primary,
            primaryFailed,
            operationsSettled: () => !retained && !pending.size,
            removeProfile,
            diagnostics: reportErrors.map((error) => ({
              label: 'Progress reporting',
              run: async () => {
                throw error;
              },
            })),
            secondary: (error) =>
              record('cleanup-failed', {
                message: diagnosticString(error),
              }),
            writeEvidence: async () =>
              report(
                JSON.stringify({
                  audit: 'authoring',
                  stage,
                  status: 'finished',
                  phase,
                  pid: owner?.child?.pid ?? null,
                  evidence: [...evidence],
                }),
              ),
          })
          .finally(detach);
      },
    };
  };
}
