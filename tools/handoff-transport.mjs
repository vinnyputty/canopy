import { AuditOwner, deadline } from './audit-lifecycle.mjs';

export function observeHandoffClose(child) {
  return new Promise((resolve, reject) => {
    let failed = false;
    let primary;
    const onError = (error) => {
      if (!failed) {
        failed = true;
        primary = error;
      }
    };
    const onClose = (code, signal) => {
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      if (failed) reject(primary);
      else if (code !== 0 || signal !== null)
        reject(new Error('Sample process did not close normally.'));
      else resolve();
    };
    child.on('error', onError);
    child.once('close', onClose);
  });
}

// Retain the original operation, not the Promise.race returned by a deadline.
export class HandoffOperations {
  pending = new Set();
  run(operation) {
    const original = Promise.resolve().then(operation);
    this.pending.add(original);
    original.then(
      () => this.pending.delete(original),
      () => this.pending.delete(original),
    );
    return original;
  }
  async settle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

// These fields are read-only evidence from the exact pinned canonical source.
// No caller constructs a scope or supplies a birth token/signaling authority.
function retainedBirth(owner, child) {
  const scopes = owner.scopes;
  return (
    scopes?.length === 1 &&
    scopes[0].child === child &&
    owner.child === child &&
    typeof scopes[0].rootStart === 'string' &&
    scopes[0].rootStart.length > 0 &&
    !scopes[0].captureError
  );
}

export function createHandoffTransport({
  profile,
  executable,
  open,
  duplicate,
  Owner = AuditOwner,
}) {
  const operations = new HandoffOperations();
  const owners = [];
  return {
    operations,
    owners,
    deadline(operation, ms, label) {
      // Cleanup retains its own original promise; including it among the
      // acquisition/UI operations it waits for would create a dependency cycle.
      const original =
        label === 'Owned sample shutdown'
          ? operation()
          : operations.run(operation);
      return deadline(() => original, ms, label);
    },
    owner() {
      const canonical = new Owner({ profile, executable });
      let session;
      let child;
      let closed;
      let acquired = false;
      let closing = false;
      let cleanup;
      const acquire = (operation, confirm) => {
        if (closing || acquired)
          throw new Error(
            'Sample owner refuses repeated or closing acquisition.',
          );
        acquired = true;
        return operations.run(async () => {
          if (closing)
            throw new Error('Sample acquisition cancelled before launch.');
          const result = await canonical.launch(async () => {
            const value = await operation();
            child = confirm(value);
            return value;
          });
          canonical.confirm(child);
          if (!retainedBirth(canonical, child))
            throw new Error(
              'Original launch birth unconfirmed; retain sample profile.',
            );
          return result;
        });
      };
      const owner = {
        canonical,
        open(options) {
          return acquire(
            async () => {
              session = await open(options);
              return session;
            },
            (value) => {
              const original = value.process();
              // An already-exited handle cannot establish whether its close
              // event was missed. Retain rather than infer full close.
              if (original.exitCode === null && original.signalCode === null) {
                closed = observeHandoffClose(original);
                closed.catch(() => {});
              }
              return original;
            },
          );
        },
        async duplicate(options) {
          const result = await acquire(
            () => {
              const launched = duplicate(options);
              closed = launched.closed;
              // A direct launcher returns the original ChildProcess and its
              // original close observation, before waiting for either one.
              operations.run(() => launched.closed);
              return launched;
            },
            (value) => value.child,
          );
          closed = result.closed;
          await deadline(() => result.closed, 10_000, 'Duplicate close');
        },
        shutdown() {
          closing = true;
          cleanup ??= (async () => {
            await operations.settle();
            const retained = child ?? canonical.child;
            if (!retained || !retainedBirth(canonical, retained)) {
              canonical.restore();
              return {
                terminated: false,
                errors: [
                  new Error(
                    'Original birth/child ownership unconfirmed; profile retained.',
                  ),
                ],
              };
            }
            let closeSettled = !session;
            let closeStarted = false;
            const close = session
              ? () => {
                  if (closeStarted)
                    throw new Error('Sample close already started.');
                  closeStarted = true;
                  return operations
                    .run(() => session.close())
                    .finally(() => {
                      closeSettled = true;
                    });
                }
              : undefined;
            const result = await canonical.shutdown(close);
            if (!closed)
              return {
                terminated: false,
                errors: [
                  ...result.errors,
                  new Error(
                    'Original process close observation unconfirmed; profile retained.',
                  ),
                ],
              };
            if (result.terminated) {
              try {
                await closed;
              } catch (error) {
                return { terminated: false, errors: [...result.errors, error] };
              }
            }
            if (!closeSettled || operations.pending.size)
              return {
                terminated: false,
                errors: [
                  ...result.errors,
                  new Error(
                    'Original sample operation/close still pending; profile retained.',
                  ),
                ],
              };
            return result;
          })();
          // Handle late rejection even when the outer shutdown deadline wins.
          cleanup.catch(() => {});
          return cleanup;
        },
      };
      owners.push(owner);
      return owner;
    },
  };
}
