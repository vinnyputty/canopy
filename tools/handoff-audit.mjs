// No process helper is forked here. Native launch is blocked until the shared
// ownership transport is integrated and qualified for this target/platform.
export function requireHandoffLifecycle() {
  throw new Error(
    'handoff_check is blocked: integrate and review the shared issue 85 ownership helper; Windows qualification remains pending. No native launch or clipboard acceptance is authorized by this target.',
  );
}

// Testable sample workflow. The future shared adapter must retain each owned
// launch BEFORE it starts, including late startup and fast-exiting duplicates.
// Its shutdown must verify every owned descendant's absence, not just exit.
export async function runSampleAudit({
  transport,
  options,
  expect,
  writeEvidence,
}) {
  const owners = [];
  const secondary = [];
  let session;
  let primary;
  let hasPrimary = false;
  let copied = false;
  const own = () => {
    const owner = transport.owner(options);
    owners.push(owner);
    return owner;
  };
  const bounded = (fn, label) => transport.deadline(fn, 30_000, label);
  try {
    const owner = own();
    session = await bounded(
      () => owner.open({ ...options, key: 'CAN-111' }),
      'Sample startup',
    );
    const page = await bounded(() => session.firstWindow(), 'Sample window');
    // Fixture installed this sink before production registered copyText IPC.
    const isolation = await bounded(
      () => session.evaluate(() => globalThis.handoffAuditCopy.inspect()),
      'Sample copy isolation',
    );
    if (isolation.count !== 0 || isolation.text !== undefined)
      throw new Error('Sample copy sink was used before explicit review.');
    await bounded(
      () =>
        expect(page.locator('[data-tree-key="CAN-111"]')).toHaveAttribute(
          'aria-selected',
          'true',
        ),
      'Startup selection',
    );
    await bounded(
      () =>
        session.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].minimize(),
        ),
      'Minimize sample',
    );
    const duplicate = own();
    await bounded(
      () => duplicate.duplicate({ ...options, key: 'CAN-112' }),
      'Duplicate sample',
    );
    await bounded(
      () =>
        expect(page.locator('[data-tree-key="CAN-112"]')).toHaveAttribute(
          'aria-selected',
          'true',
        ),
      'Running selection',
    );
    await bounded(
      () =>
        expect
          .poll(() =>
            session.evaluate(({ BrowserWindow }) => {
              const windows = BrowserWindow.getAllWindows();
              return (
                windows.length === 1 &&
                !windows[0].isMinimized() &&
                windows[0].isFocused()
              );
            }),
          )
          .toBe(true),
      'Native focus',
    );
    await bounded(
      () => page.locator('[data-tree-key="CAN-112"]').press('Space'),
      'Sample preview',
    );
    await bounded(
      () =>
        page
          .getByRole('button', { name: 'Copy work brief', exact: true })
          .click(),
      'Sample review',
    );
    const dialog = page.getByRole('dialog');
    await bounded(
      () => dialog.getByLabel('Copy format').selectOption('custom'),
      'Sample format',
    );
    const text = await bounded(
      () => dialog.locator('pre').textContent(),
      'Reviewed text',
    );
    if (typeof text !== 'string' || text.length > 100_000)
      throw new Error('Invalid reviewed sample text.');
    // Recheck immediately before the only explicit sample copy dispatch.
    const before = await bounded(
      () => session.evaluate(() => globalThis.handoffAuditCopy.inspect()),
      'Before sample copy',
    );
    if (before.count !== 0 || before.text !== undefined)
      throw new Error('Unexpected sample copy before review.');
    await bounded(
      () =>
        dialog
          .getByRole('button', { name: 'Copy issue context', exact: true })
          .click(),
      'Explicit sample copy',
    );
    const after = await bounded(
      () => session.evaluate(() => globalThis.handoffAuditCopy.inspect()),
      'After sample copy',
    );
    if (after.count !== 1 || after.text !== text)
      throw new Error('Sample sink differs from reviewed text.');
    copied = true;
  } catch (error) {
    hasPrimary = true;
    primary = error;
  }
  let absent = true;
  for (const owner of owners.reverse()) {
    try {
      const result = await transport.deadline(
        () => owner.shutdown(),
        90_000,
        'Owned sample shutdown',
      );
      if (result.terminated !== true) {
        absent = false;
        secondary.push(
          new Error(
            'Owned descendant absence unconfirmed; retain evidence/profile.',
          ),
        );
      }
      secondary.push(...result.errors);
    } catch (error) {
      absent = false;
      secondary.push(error);
    }
  }
  try {
    await bounded(
      () =>
        writeEvidence({
          sampleCopySink: copied,
          systemClipboard: 'NOT RUN',
          confirmedOwnedAbsence: absent,
          profileRetained: true,
          failed: hasPrimary || secondary.length > 0,
        }),
      'Sample evidence',
    );
  } catch (error) {
    secondary.push(error);
  }
  // Never remove the sample profile. Never restore native methods in a still
  // live/uncertain process; the fixture restores them on its own exit.
  if (hasPrimary) {
    if (!secondary.length) throw primary;
    throw new AggregateError(
      [primary, ...secondary],
      'Sample audit failed; cleanup diagnostics attached.',
      { cause: primary },
    );
  }
  if (secondary.length)
    throw new AggregateError(secondary, 'Sample cleanup failed.');
}
