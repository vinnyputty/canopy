import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runCimContextControls } from '../tools/windows-cim-input-control.mjs';

const helper = new URL(
  '../tools/windows-cim-input-control.mjs',
  import.meta.url,
).href;
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const metadata = {
  imageHash: hash('image'),
  psHomeHash: hash('home'),
  cwdHash: hash('cwd'),
  tempHash: hash('temp'),
  cacheHash: hash('cache'),
  manifestHash: hash('manifest'),
  manifestReadable: true,
  tempExists: true,
  cacheParentExists: true,
  version: '5.1.26100.1',
  edition: 'Desktop',
  is64Bit: true,
  dllArchitecture: 'MSIL',
};

function modeled(source: string) {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', source],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
const setup = `
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {inspect} from 'node:util';
const metadata=${JSON.stringify(metadata)};
const children=[];const contexts=[];
const env={SystemRoot:'private-system-root',RUNNER_TEMP:'private-runner-temp',Temp:'private-old-temp',TMP:'private-old-tmp',pSmOdUlEaNaLySiScAcHePaTh:'private-old-cache',PSModulePath:'private-module',PRIVATE_SECRET:'private-secret-token'};
function child(options){
 const c=new EventEmitter(); c.pid=123456;c.killed=false;
 c.stdout=new PassThrough();c.stderr=new PassThrough();c.stdin=null;c.unref=()=>{};
 children.push(c);contexts.push(options);return c;
}
`;

test('actual context helper isolates one boundary per child, keeps private values out of records and closes real owned Node comparisons', async () => {
  const env = {
    ...process.env,
    SystemRoot: tmpdir(),
    RUNNER_TEMP: tmpdir(),
    PSModuleAnalysisCachePath: 'private-cache-value',
    private_sentinel: 'private-retained-secret',
  };
  const original = { ...env };
  const scripts: string[] = [];
  const records = await runCimContextControls({
    command: process.execPath,
    env,
    argsFor: (script) => {
      scripts.push(script);
      return [
        '-e',
        `
      const {createHash}=require('node:crypto');
      if(process.env.private_sentinel!=='private-retained-secret')process.exit(9);
      const hash=v=>createHash('sha256').update(v).digest('hex');
      const row=${JSON.stringify(metadata)};
      row.cwdHash=hash(process.cwd()); row.tempHash=hash(process.env.TEMP||'absent');row.cacheHash=hash(process.env.PSModuleAnalysisCachePath||'absent');
      console.log(JSON.stringify(row));console.log('canopy-context complete');
    `,
      ];
    },
    report: (record) => assert.ok(!JSON.stringify(record).includes('private-')),
  });
  assert.deepEqual(env, original);
  assert.equal(records.length, 4);
  assert.ok(records.every((r) => r.ok && r.closed));
  assert.equal(records[2].metadata!.cacheHash, hash('NUL'));
  assert.equal(records[3].metadata!.tempHash, hash(tmpdir()));
  assert.equal(new Set(scripts).size, 1);
  assert.ok(!scripts[0].includes('Get-CimInstance'));
  assert.ok(
    !scripts[0].includes('ConvertTo-Json'),
    'metadata must not autoload Utility before the import under observation',
  );
  assert.equal(scripts[0].match(/Import-Module CimCmdlets;/g)?.length, 1);
});

test('injected contexts preserve environment and cwd boundaries without secrets or arbitrary metadata', () => {
  modeled(`${setup}
    cp.spawn=(command,args,options)=>{const c=child(options);c.kill=()=>{c.killed=true;queueMicrotask(()=>c.emit('close',null,'SIGKILL'));return true;};queueMicrotask(()=>{c.stdout.emit('data',JSON.stringify(metadata)+'\\ncanopy-context complete\\n');c.emit('close',0,null);});return c;};
    syncBuiltinESMExports();
    const {runCimContextControls}=await import(${JSON.stringify(helper)});
    const original={...env};const records=await runCimContextControls({env,report:()=>{}});
    assert.deepEqual(env,original);assert.equal(records.length,4);
    assert.deepEqual(contexts[0].env,Object.fromEntries(Object.entries(env).filter(([key])=>key!=='PSModulePath')));
    assert.equal(contexts[0].cwd,undefined);assert.equal(contexts[1].cwd,env.SystemRoot);
    assert.equal(contexts[2].env.PSModuleAnalysisCachePath,'NUL');assert.ok(!('pSmOdUlEaNaLySiScAcHePaTh' in contexts[2].env));
    assert.equal(contexts[3].env.TEMP,env.RUNNER_TEMP);assert.equal(contexts[3].env.TMP,env.RUNNER_TEMP);assert.ok(!('Temp' in contexts[3].env));
    assert.ok(!JSON.stringify(records).includes('private-'));assert.ok(records.every(r=>r.ok));
    for(const options of contexts){assert.equal(options.timeout,0);assert.equal(options.maxBuffer,16384);assert.deepEqual(options.stdio,['ignore','pipe','pipe']);}
  `);
});

test('context malformed metadata and both stream caps fail safely while complete child closure preserves later comparisons', () => {
  modeled(`${setup}
    let n=0;
    cp.spawn=(command,args,options)=>{const c=child(options);const index=n++;c.kill=()=>{c.killed=true;queueMicrotask(()=>c.emit('close',null,'SIGKILL'));return true;};queueMicrotask(()=>{
      if(index===0)c.stdout.emit('data',JSON.stringify({...metadata,CommandLine:'private-secret-token'}));
      else if(index===1)c.stdout.emit('data','private-secret-token'.repeat(2000));
      else if(index===2)c.stderr.emit('data','private-secret-token'.repeat(2000));
      else c.stdout.emit('data',JSON.stringify(metadata)+'\\ncanopy-context complete\\n');
      c.emit('close',0,null);
    });return c;};
    syncBuiltinESMExports();const {runCimContextControls}=await import(${JSON.stringify(helper)});
    const records=await runCimContextControls({env,report:()=>{}});
    assert.deepEqual(records.map(r=>r.ok),[false,false,false,true]);
    assert.equal(records[0].error,'CONTEXT_SCHEMA_FAILED');assert.equal(records[0].metadata,undefined);
    assert.equal(records[1].code,'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');assert.equal(records[2].code,'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    assert.ok(!JSON.stringify(records).includes('private-'));
  `);
});

test('unconfirmed context closure retains exact child, falsy primary and reporting/cleanup faults, and blocks later launches', () => {
  modeled(`${setup}
    const primary=undefined;const denied=new Error('private-kill-error');
    cp.spawn=(command,args,options)=>{const c=child(options);c.kill=()=>{throw denied};queueMicrotask(()=>c.stderr.emit('error',primary));return c;};
    syncBuiltinESMExports();const {runCimContextControls}=await import(${JSON.stringify(helper)});
    let failure;try{await runCimContextControls({env,report:()=>{throw null}})}catch(error){failure=error;}
    assert.equal(children.length,1);assert.equal(failure.child,children[0]);assert.ok(Object.hasOwn(failure,'primary'));assert.equal(failure.primary,undefined);
    assert.deepEqual(failure.cleanupErrors,[denied]);assert.equal(failure.reportError,null);
    assert.ok(!inspect(failure).includes('private-'));assert.ok(!JSON.stringify(failure).includes('private-'));
    for(const emitter of [children[0],children[0].stdout,children[0].stderr])for(const event of ['close','error','data'])assert.equal(emitter.listenerCount(event),0);
  `);
});

test('actual worker context before-hook rejects following fixtures when direct closure is unconfirmed', async () => {
  const worker = await readFile(
    new URL('./audit-lifecycle.test.ts', import.meta.url),
    'utf8',
  );
  const start = worker.indexOf(
    "if (process.platform === 'win32')",
    worker.indexOf('const processBudgets'),
  );
  const hook = worker
    .slice(start, worker.indexOf('const sleep'))
    .replace("if (process.platform === 'win32')", 'if (true)')
    .replace(
      'runCimContextControls()',
      'runCimContextControls({env,report:()=>{}})',
    );
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `${setup}
    import {before,test} from 'node:test';
    cp.spawn=(command,args,options)=>{const c=child(options);c.kill=()=>false;queueMicrotask(()=>c.stderr.emit('error',null));return c;};
    syncBuiltinESMExports();const {runCimContextControls}=await import(${JSON.stringify(helper)});
    ${hook}
    test('required ownership fixture',()=>console.log('FIXTURE_STARTED'));
  `,
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.ok(!result.stdout.includes('FIXTURE_STARTED'));
  assert.match(result.stdout, /closure unconfirmed/);
});

test('overall context allowance prevents later launches after elapsed budget is exhausted', () => {
  modeled(`${setup}
    const now=Date.now;let offset=0;Date.now=()=>now()+offset;
    cp.spawn=(command,args,options)=>{const c=child(options);queueMicrotask(()=>{c.stdout.emit('data',JSON.stringify(metadata)+'\\ncanopy-context complete\\n');offset=60000;c.emit('close',0,null);});return c;};
    syncBuiltinESMExports();const {runCimContextControls}=await import(${JSON.stringify(helper)});
    const records=await runCimContextControls({env,report:()=>{}});
    assert.equal(children.length,1);assert.equal(records.length,4);
    assert.ok(records.slice(1).every(r=>r.error==='CONTEXT_BUDGET_EXHAUSTED'));
  `);
});

test('real owned context output limits drain and close every direct child without exposing private bytes', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const records = await runCimContextControls({
      command: process.execPath,
      env: { ...process.env, SystemRoot: tmpdir(), RUNNER_TEMP: tmpdir() },
      argsFor: () => [
        '-e',
        `process.${stream}.write('private-stream-token'.repeat(1000)); setInterval(()=>{},1000);`,
      ],
      report: (record) => {
        assert.ok(record.childPid);
        assert.throws(() => process.kill(record.childPid!, 0), {
          code: 'ESRCH',
        });
        assert.ok(!JSON.stringify(record).includes('private-stream-token'));
      },
    });
    assert.ok(
      records.every(
        (r) => !r.ok && r.closed && r.error === 'CONTEXT_OPERATION_FAILED',
      ),
    );
  }
});
