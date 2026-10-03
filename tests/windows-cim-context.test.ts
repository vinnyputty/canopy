import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runCimContextControls } from '../tools/windows-cim-input-control.mjs';

const helper =
  process.env.CANOPY_CIM_CONTEXT_SOURCE ??
  new URL('../tools/windows-cim-input-control.mjs', import.meta.url).href;
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
  assert.notEqual(records[2].metadata!.cacheHash, hash('private-cache-value'));
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
    assert.equal(contexts[2].env.PRIVATE_SECRET,env.PRIVATE_SECRET);assert.ok(!('pSmOdUlEaNaLySiScAcHePaTh' in contexts[2].env));assert.match(contexts[2].env.PSModuleAnalysisCachePath,/ModuleAnalysisCache$/);
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

test('context operation timing stays distinct from cumulative suite timing', () => {
  modeled(`${setup}
    let clock=1000;Date.now=()=>clock;
    cp.spawn=(command,args,options)=>{const c=child(options);queueMicrotask(()=>{clock+=120;c.stdout.emit('data',JSON.stringify(metadata)+'\\ncanopy-context complete\\n');c.emit('close',0,null);});return c;};
    syncBuiltinESMExports();const {runCimContextControls}=await import(${JSON.stringify(helper)});
    const records=await runCimContextControls({env,report:()=>{}});
    assert.deepEqual(records.map(r=>r.elapsedMs),[120,120,120,120],'operation durations must not include previous comparisons');
    assert.deepEqual(records.map(r=>r.suiteElapsedMs),[120,240,360,480]);
    assert.ok(records.every(r=>r.timeoutMs===10000 && r.closed && r.ok));
  `);
});

test('private writable cache comparison changes only the child cache path and removes it after confirmed closure', () => {
  modeled(`${setup}
    import fs from 'node:fs';
    import path from 'node:path';
    const scripts=[];let cacheDirectory;
    cp.spawn=(command,args,options)=>{scripts.push(Buffer.from(args.at(-1),'base64').toString('utf16le'));const c=child(options);
      if(children.length===3){cacheDirectory=path.dirname(options.env.PSModuleAnalysisCachePath);assert.ok(path.isAbsolute(cacheDirectory) && path.basename(cacheDirectory).startsWith('canopy-cim-cache-'));assert.ok(fs.existsSync(cacheDirectory));fs.writeFileSync(options.env.PSModuleAnalysisCachePath,'private-cache-token');}
      queueMicrotask(()=>{c.stdout.emit('data',JSON.stringify(metadata)+'\\ncanopy-context complete\\n');c.emit('close',0,null);});return c;};
    syncBuiltinESMExports();const {runCimContextControls}=await import(${JSON.stringify(helper)});
    const records=await runCimContextControls({env,report:()=>{}});
    assert.equal(records[2].mode,'isolated-cache');assert.equal(new Set(scripts).size,1);
    const clean=e=>Object.fromEntries(Object.entries(e).filter(([key])=>key.toUpperCase()!=='PSMODULEANALYSISCACHEPATH'));
    assert.deepEqual(clean(contexts[2].env),clean(contexts[0].env));assert.equal(contexts[2].cwd,contexts[0].cwd);
    assert.notEqual(contexts[2].env.PSModuleAnalysisCachePath,'NUL');assert.equal(fs.existsSync(cacheDirectory),false);
    assert.ok(records.every(r=>r.ok && r.closed));assert.ok(!JSON.stringify(records).includes('private-'));
    for(const c of children)assert.equal(c.listenerCount('close'),0);
  `);
});

test('unconfirmed private-cache child retains its owned cache without exposing its path or launching another comparison', () => {
  modeled(`${setup}
    import fs from 'node:fs';import path from 'node:path';
    let cacheDirectory;
    cp.spawn=(command,args,options)=>{const c=child(options);c.kill=()=>false;
      if(children.length===3){cacheDirectory=path.dirname(options.env.PSModuleAnalysisCachePath);queueMicrotask(()=>c.stderr.emit('error',undefined));}
      else queueMicrotask(()=>{c.stdout.emit('data',JSON.stringify(metadata)+'\\ncanopy-context complete\\n');c.emit('close',0,null);});return c;};
    syncBuiltinESMExports();const {runCimContextControls}=await import(${JSON.stringify(helper)});
    let failure;try{await runCimContextControls({env,report:()=>{}})}catch(error){failure=error;}
    try {
      assert.equal(children.length,3);assert.equal(failure.child,children[2]);assert.equal(failure.primary,undefined);
      assert.equal(failure.cacheDirectory,cacheDirectory);assert.ok(fs.existsSync(cacheDirectory));
      assert.ok(!inspect(failure).includes(cacheDirectory));assert.ok(!JSON.stringify(failure).includes(cacheDirectory));
    } finally {if(cacheDirectory)fs.rmSync(cacheDirectory,{recursive:true,force:true});}
  `);
});

for (const fault of ['allocate', 'remove']) {
  test(`private cache ${fault} failure retains private primary and stops later comparisons`, () => {
    modeled(`${setup}
      import fs from 'node:fs';import fsp from 'node:fs/promises';import path from 'node:path';
      const originalRemove=fsp.rm;let cacheDirectory;
      if(${JSON.stringify(fault)}==='allocate')fsp.mkdtemp=async()=>{throw undefined};
      else fsp.rm=async()=>{throw null};
      cp.spawn=(command,args,options)=>{const c=child(options);c.kill=()=>true;
        if(children.length===3){cacheDirectory=path.dirname(options.env.PSModuleAnalysisCachePath);queueMicrotask(()=>{c.stderr.emit('error',false);c.emit('close',null,'SIGKILL');});}
        else queueMicrotask(()=>{c.stdout.emit('data',JSON.stringify(metadata)+'\\ncanopy-context complete\\n');c.emit('close',0,null);});return c;};
      syncBuiltinESMExports();const {runCimContextControls}=await import(${JSON.stringify(helper)});
      let failure;try{await runCimContextControls({env,report:r=>{if(r.mode==='isolated-cache')throw undefined}})}catch(error){failure=error;}
      try {
        assert.ok(Object.hasOwn(failure,'primary'));
        assert.equal(failure.primary,${JSON.stringify(fault)}==='allocate'?undefined:false);
        assert.equal(children.length,${JSON.stringify(fault)}==='allocate'?2:3);
        if(cacheDirectory){assert.equal(failure.cacheDirectory,cacheDirectory);assert.deepEqual(failure.cleanupErrors,[null]);assert.ok(Object.hasOwn(failure,'reportError'));assert.equal(failure.reportError,undefined);assert.ok(!inspect(failure).includes(cacheDirectory));}
      } finally {if(cacheDirectory)await originalRemove(cacheDirectory,{recursive:true,force:true});}
    `);
  });
}

for (const operation of ['allocate', 'remove']) {
  test(`hung cache ${operation} is bounded and retains its private pending filesystem handle`, () => {
    modeled(`${setup}
      import fs from 'node:fs/promises';import path from 'node:path';
      const originalMkdir=fs.mkdtemp;const originalRemove=fs.rm;let directory;let resolveWork;
      const pending=new Promise(resolve=>{resolveWork=resolve});
      if(${JSON.stringify(operation)}==='allocate')fs.mkdtemp=()=>pending;
      else fs.rm=()=>pending;
      cp.spawn=(command,args,options)=>{const c=child(options);if(children.length===3)directory=path.dirname(options.env.PSModuleAnalysisCachePath);queueMicrotask(()=>{c.stdout.emit('data',JSON.stringify(metadata)+'\\ncanopy-context complete\\n');c.emit('close',0,null);});return c;};
      syncBuiltinESMExports();const {runCimContextControls}=await import(${JSON.stringify(helper)});
      const start=Date.now();let failure;
      try{await runCimContextControls({env,report:()=>{}})}catch(error){failure=error;}
      assert.ok(Date.now()-start<3000);assert.match(failure.message,/cache (allocation|cleanup) failed/);
      assert.equal(children.length,${JSON.stringify(operation)}==='allocate'?2:3);
      assert.equal(failure[${JSON.stringify(operation)}==='allocate'?'cacheAllocation':'cacheRemoval'],pending);
      if(${JSON.stringify(operation)}==='allocate'){directory=await originalMkdir(path.join((await import('node:os')).tmpdir(),'canopy-cim-cache-'));resolveWork(directory);}else resolveWork();
      await originalRemove(directory,{recursive:true,force:true});
    `);
  });
}
