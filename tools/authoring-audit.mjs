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
      async launch(phase, operation) {
        if (owner) throw new Error('Previous authoring scope is not closed');
        owner = new lifecycle.AuditOwner({ profile, executable });
        closeAttempted = false;
        const app = await run(`${phase}:launch`, () => owner.launch(operation));
        // Retain/confirm the real ChildProcess, never a bare PID.
        owner.confirm(app.process());
        return app;
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
      },
      failure(error) {
        record('primary', {
          message: diagnosticString(error),
          exitCode: owner?.child?.exitCode ?? null,
          signalCode: owner?.child?.signalCode ?? null,
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
        await lifecycle.finishAudit({
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
              }),
            ),
        });
      },
    };
  };
}
