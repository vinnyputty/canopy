// Stage only the controlled sample fixture. No credential/keychain operations.
import { build } from 'esbuild';
import { cp, chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [destination, builtDist] = process.argv.slice(2);
if (!destination || !builtDist)
  throw new Error(
    'Usage: stage-backup-smoke.mjs <owned empty directory> <built dist>',
  );
const stage = resolve(destination);
await mkdir(stage, { recursive: true });
if ((await readdir(stage)).length)
  throw new Error('Sample staging directory must be empty');
await cp(resolve(builtDist), join(stage, 'dist'), {
  recursive: true,
  dereference: true,
});
async function writable(directory) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await writable(path);
    else await chmod(path, 0o600);
  }
}
await writable(join(stage, 'dist'));
await writeFile(
  join(stage, 'package.json'),
  JSON.stringify({
    name: 'canopy-backup-sample',
    version: '0.0.0',
    main: 'dist/smoke-main.cjs',
  }),
);
await build({
  entryPoints: [join(root, 'tests/fixtures/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outfile: join(stage, 'dist/smoke-main.cjs'),
  plugins: [
    {
      name: 'backup-sample-only',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, (args) =>
          /[\\/]storage\.ts$/.test(args.importer)
            ? { path: 'keychain', namespace: 'backup-fixture' }
            : undefined,
        );
        b.onResolve({ filter: /^\.\/auth$/ }, (args) =>
          /[\\/]app\.ts$/.test(args.importer)
            ? { path: 'accounts', namespace: 'backup-fixture' }
            : undefined,
        );
        b.onResolve({ filter: /^\.\/jira$/ }, (args) =>
          /[\\/]app\.ts$/.test(args.importer)
            ? { path: 'provider', namespace: 'backup-fixture' }
            : undefined,
        );
        b.onResolve({ filter: /^node:fs\/promises$/ }, (args) =>
          /[\\/](storage|replace-file)\.ts$/.test(args.importer)
            ? { path: 'filesystem', namespace: 'backup-fixture' }
            : undefined,
        );
        b.onLoad({ filter: /.*/, namespace: 'backup-fixture' }, (args) => {
          if (args.path === 'keychain')
            return {
              resolveDir: root,
              contents: `globalThis.canopyBackupKeychainForbidden=true; export const safeStorage = new Proxy({}, {get(){globalThis.canopyKeychainAccesses=(globalThis.canopyKeychainAccesses??0)+1; throw new Error('Keychain forbidden in backup fixture');}});`,
            };
          if (args.path === 'accounts')
            return {
              resolveDir: root,
              contents: `import {Auth as RealAuth} from ${JSON.stringify(join(root, 'src/main/auth.ts'))}; export class Auth extends RealAuth {async load() {} connections(){return globalThis.canopyBackupExtraConnections ?? [{id:'fixture-beta',name:'Sample Beta',provider:'jira',url:'https://example.invalid',accountName:'beta-sample-account',repositories:['sample/repo']}];} async request(id,path){if(path==='/rest/api/3/myself') return {accountId:'beta',displayName:'Beta Sample'};throw new Error('Live requests forbidden in backup fixture');}}`,
            };
          if (args.path === 'provider')
            return {
              resolveDir: root,
              contents: `import {JiraProvider as RealProvider} from ${JSON.stringify(join(root, 'src/main/jira.ts'))};export {jiraRemoteLinkUrl} from ${JSON.stringify(join(root, 'src/main/jira.ts'))};export class JiraProvider extends RealProvider {tree(key){globalThis.canopyBackupBetaFetches=(globalThis.canopyBackupBetaFetches??0)+1;return globalThis.canopySmoke.tree(key);} preview(key){return globalThis.canopySmoke.preview(key);} priorities(key){return globalThis.canopySmoke.priorities(key);} transitions(key){return globalThis.canopySmoke.transitions(key);} cachedUsers(){return globalThis.canopySmoke.cachedUsers();} assignees(...args){return globalThis.canopySmoke.assignees(...args);} priorityOrder(...args){return globalThis.canopySmoke.priorityOrder(...args);} invalidateChoices() {}}`,
            };
          return {
            resolveDir: root,
            contents: `export * from 'node:fs/promises';
import {writeFile as write,rename as move,mkdir,rm,readFile,chmod,stat} from 'node:fs/promises';
import {basename,dirname} from 'node:path';
function fault(contents) {const f=globalThis.canopyBackupFault;return f && JSON.parse(contents).theme===f.theme ? f : null;}
export async function writeFile(file,contents,options) {
  const f=basename(file)==='workspace.json.tmp' ? fault(contents) : null;
  if(f?.mode!=='staging') return write(file,contents,options);
  globalThis.canopyBackupFault=null;
  await mkdir(file);
  try {await write(file,contents,options);} catch(error){globalThis.canopyBackupFaultResult={mode:f.mode,code:error.code};throw error;} finally {await rm(file,{recursive:true,force:true});}
}
export async function rename(source,destination) {
  const f=basename(destination)==='workspace.json' ? fault(await readFile(source,'utf8')) : null;
  if(f?.mode!=='replacement') return move(source,destination);
  globalThis.canopyBackupFault=null;
  const directory=dirname(destination),mode=(await stat(directory)).mode & 0o777;
  await chmod(directory,0o500);
  try {await move(source,destination);throw new Error('Expected native replacement denial');} catch(error){globalThis.canopyBackupFaultResult={mode:f.mode,code:error.code};throw error;} finally {await chmod(directory,mode);}
}`,
          };
        });
      },
    },
  ],
});
console.log(stage);
