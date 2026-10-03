import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import ts from 'typescript';
import {
  AuditOwner,
  deadline,
  finishAudit,
} from '../tools/audit-lifecycle.mjs';

const values = [0, false, '', null, undefined];
const noop = async () => {};
function owner(
  shutdown = async () => ({ terminated: true, errors: [] as unknown[] }),
) {
  return { profile: 'controlled', shutdown } as unknown as AuditOwner;
}
async function rejected(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    return { error };
  }
  assert.fail('operation resolved instead of preserving its failure');
}

test('healthy finalization accepts omitted primary and always-present undefined', async () => {
  for (const options of [
    {},
    { primary: undefined },
    { primary: undefined, primaryFailed: false },
  ]) {
    const effects: string[] = [];
    await finishAudit({
      owner: owner(async () => {
        effects.push('shutdown');
        return { terminated: true, errors: [] };
      }),
      ...options,
      removeProfile: async () => {
        effects.push('remove');
      },
      writeEvidence: async () => {
        effects.push('evidence');
      },
    });
    assert.deepEqual(effects, ['shutdown', 'remove', 'evidence']);
  }
});

for (const primary of values) {
  test(`explicit caught ${String(primary)} stays the exact rejection after healthy cleanup`, async () => {
    let removed = false;
    let written = false;
    const result = await rejected(() =>
      finishAudit({
        owner: owner(),
        primary,
        primaryFailed: true,
        removeProfile: async () => {
          removed = true;
        },
        writeEvidence: async () => {
          written = true;
        },
      }),
    );
    assert.equal(result.error, primary);
    assert.ok(removed && written);
  });
  if (primary !== undefined) {
    test(`existing primary-only caller preserves ${String(primary)}`, async () => {
      const result = await rejected(() =>
        finishAudit({
          owner: owner(),
          primary,
          removeProfile: noop,
          writeEvidence: noop,
        }),
      );
      assert.equal(result.error, primary);
    });
  }
  for (const phase of [
    'shutdown',
    'remove',
    'evidence',
    'reporting',
    'unknown',
    'diagnostic',
  ]) {
    test(`${String(primary)} remains first with ${phase} failure`, async () => {
      let removed = false;
      let written = false;
      const result = await rejected(() =>
        finishAudit({
          primary,
          primaryFailed: true,
          owner: owner(async () => {
            if (phase === 'shutdown') throw undefined;
            return {
              terminated: phase !== 'unknown',
              errors: phase === 'reporting' ? [false] : [],
            };
          }),
          diagnostics:
            phase === 'diagnostic'
              ? [
                  {
                    label: 'Controlled diagnostic',
                    run: async () => {
                      throw null;
                    },
                  },
                ]
              : [],
          removeProfile: async () => {
            removed = true;
            if (phase === 'remove') throw undefined;
          },
          writeEvidence: async () => {
            written = true;
            if (phase === 'evidence') throw null;
          },
          secondary: (error) => {
            assert.ok(error instanceof Error);
            if (phase === 'reporting') throw undefined;
          },
        }),
      );
      assert.ok(result.error instanceof AggregateError);
      assert.equal(result.error.cause, primary);
      assert.equal(result.error.errors[0], primary);
      assert.ok(written);
      assert.equal(removed, !['unknown', 'shutdown'].includes(phase));
      if (phase === 'shutdown') assert.equal(result.error.errors[1], undefined);
      if (phase === 'reporting') {
        assert.equal(result.error.errors[1], false);
        assert.equal(result.error.errors[2].cause, undefined);
      }
      if (['remove', 'evidence', 'diagnostic'].includes(phase)) {
        assert.equal(
          result.error.errors[1].cause,
          phase === 'remove' ? undefined : null,
        );
      }
    });
  }
}

for (const secondary of [null, undefined]) {
  test(`secondary-only thrown ${String(secondary)} is a failure and retains an unconfirmed profile`, async () => {
    let removed = false;
    let written = false;
    const result = await rejected(() =>
      finishAudit({
        owner: owner(async () => {
          throw secondary;
        }),
        removeProfile: async () => {
          removed = true;
        },
        writeEvidence: async () => {
          written = true;
        },
      }),
    );
    assert.ok(result.error instanceof AggregateError);
    assert.equal(result.error.cause, secondary);
    assert.equal(result.error.errors[0], secondary);
    assert.equal(removed, false);
    assert.equal(written, true);
  });
}

// Execute the actual standalone palette catch/finally with controlled effects,
// not Electron. This protects healthy always-present undefined and caught undefined.
const palette = ts.createSourceFile(
  'palette-check.mjs',
  readFileSync(
    process.env.CANOPY_PALETTE_AUDIT_SOURCE ??
      new URL('../tools/palette-check.mjs', import.meta.url),
    'utf8',
  ),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const flow = palette.statements.find(
  (node) => ts.isTryStatement(node) && node.getText().includes('Palette audit'),
)!;
assert.ok(flow);
const declarations = palette.statements
  .filter(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((declaration) =>
        ['failure', 'failed'].includes(declaration.name.getText()),
      ),
  )
  .map((node) => node.getText())
  .join('\n');
const runFlow = new Function(
  'context',
  `return (async () => { const {owner, deadline, finishAudit, audit, record, directory, evidence, log, mkdir, rm, writeFile, join} = context; let app; let page; ${declarations}\n${flow.getText()} })();`,
);
for (const mode of ['healthy', ...values]) {
  test(`actual palette finalizer handles ${String(mode)} without false PASS or healthy failure`, async () => {
    const effects: string[] = [];
    const operation = () =>
      runFlow({
        owner: owner(),
        deadline,
        finishAudit,
        audit: async () => {
          if (mode !== 'healthy') throw mode;
        },
        record: (line: string) => effects.push(line),
        directory: 'controlled',
        evidence: 'controlled',
        log: [],
        join,
        mkdir: noop,
        writeFile: noop,
        rm: async () => {
          effects.push('remove');
        },
      });
    if (mode === 'healthy') await operation();
    else assert.equal((await rejected(operation)).error, mode);
    assert.ok(effects.includes('remove'));
    if (mode !== 'healthy')
      assert.ok(effects.some((line) => line.startsWith('FAIL ')));
  });
}
