import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  acceptManagedObservation,
  managedCorrelation,
  managedInstallationSha256,
  managedPaths,
  managedProfile,
  validManagedResponse,
} from './managed-appimage.mjs';

const hash = (v) => createHash('sha256').update(v).digest('hex');
const select = (v, names) => Object.fromEntries(names.map((k) => [k, v[k]]));
const metadata = (v) =>
  select(v, ['dev', 'ino', 'uid', 'gid', 'mode', 'size', 'mtimeMs', 'ctimeMs']);
const parentMetadata = (v) => select(v, ['dev', 'ino', 'uid', 'gid', 'mode']);
const identity = (v) => select(v, ['pid', 'birth', 'uid', 'parent']);
const terminal = (v) =>
  select(v, [
    'spawned',
    'closed',
    'timedOut',
    'pid',
    'birth',
    'code',
    'signal',
  ]);
const refuse = () => {
  throw new Error('Managed success evidence incomplete');
};

// Project qualified results only. Dynamic paths and correlation authority are
// hashes; fixed identifiers and numeric identities cannot carry receipt secrets.
export function managedLaunchEvidence(installed, request, observation) {
  if (
    request.operation !== 'launch' ||
    !validManagedResponse({ ok: true, value: installed }, request)
  )
    refuse();
  if (observation)
    acceptManagedObservation(
      observation,
      installed,
      request.launch,
      request.parent,
    );
  const r = installed.receipt,
    reader = r.reader;
  return {
    schema: 1,
    correlationSha256: managedCorrelation(request),
    receiptSha256: installed.receiptSha256,
    installationSha256: managedInstallationSha256(installed),
    parent: { ...select(r.parent, ['pid', 'birth']), expectedUid: r.uid },
    original: {
      path: managedPaths.original,
      sha256: r.original.hash,
      metadata: metadata(r.original.metadata),
      parents: r.original.parents.map((p, i) => ({
        label: ['root', 'var', 'var-lib', 'managed-directory'][i],
        ...parentMetadata(p),
      })),
    },
    source: {
      pathSha256: hash(r.source.path),
      sha256: r.source.sha256,
      metadata: metadata(r.source.identity),
    },
    receiptIdentity: select(r.self, [
      'dev',
      'ino',
      'uid',
      'gid',
      'mode',
      'nlink',
    ]),
    protectedParents: r.parents.map((p, i) => ({
      label: ['root', 'var', 'var-lib', 'etc', 'apparmor-dir'][i],
      ...parentMetadata(p.identity),
    })),
    resources: r.resources.map((item, i) => ({
      label: ['managed-directory', 'managed-original', 'managed-policy'][i],
      kind: item.kind,
      identity: select(
        item.identity,
        i === 0
          ? ['dev', 'ino', 'uid', 'gid', 'mode']
          : [
              'dev',
              'ino',
              'uid',
              'gid',
              'mode',
              'nlink',
              'size',
              'mtimeMs',
              'ctimeMs',
            ],
      ),
      ...(i === 0 ? {} : { sha256: item.sha256 }),
    })),
    profile: { name: managedProfile, policySha256: r.profile.sha256 },
    kernel: {
      pathSha256: hash(r.loaded.path),
      attachment: r.loaded.attach,
      mode: r.loaded.mode,
      sha256: r.loaded.sha256,
      identity: select(r.loaded.identity, [
        'dev',
        'ino',
        'uid',
        'gid',
        'mode',
        'nlink',
      ]),
      global: {
        apparmorEnabled:
          r.global['/sys/module/apparmor/parameters/enabled'].trim(),
        restrictUserns:
          r.global[
            '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'
          ].trim(),
        unprivilegedUserns:
          r.global['/proc/sys/kernel/unprivileged_userns_clone'].trim(),
      },
    },
    parserAdd: {
      writer: select(r.mutation.writer, ['pid', 'birth', 'uid']),
      child: identity(r.mutation.child),
      terminal: terminal(r.mutation.proof),
    },
    observer: observation
      ? {
          completed: observation.completed,
          status: observation.status,
          finalizedAt: observation.finalizedAt,
          authority: select(observation.authority, [
            'kind',
            'pid',
            'birth',
            'originalSha256',
            'managed',
          ]),
        }
      : null,
    reader: {
      nonceSha256: hash(reader.nonce),
      writer: select(reader.writer, ['pid', 'birth', 'uid']),
      child: identity(reader.child),
      launch: select(reader.scope.launch, [
        'pid',
        'mainBirth',
        'rootPid',
        'rootBirth',
        'rendererPid',
        'rendererBirth',
      ]),
      mount: {
        pathSha256: hash(reader.scope.mount.path),
        ...select(reader.scope.mount, ['source', 'filesystem']),
        optionsSha256: hash(reader.scope.mount.options),
        superOptionsSha256: hash(reader.scope.mount.superOptions),
      },
      uid: reader.scope.uid,
      gid: reader.scope.gid,
      namespaces: select(reader.scope.namespaces, ['user', 'mnt']),
      mappings: { uid: [0, 0, 4294967295], gid: [0, 0, 4294967295] },
      node: {
        pathSha256: hash(reader.node.path),
        identity: {
          ...metadata(reader.node.identity),
          nlink: reader.node.identity.nlink,
        },
        sha256: reader.node.sha256,
        sourceSha256: reader.node.source.sha256,
        programSha256: reader.node.source.programSha256,
      },
      terminal: { ...terminal(reader.proof), accepted: reader.proof.accepted },
    },
    // Explicit source assertions: object equality cannot be serialized as an OS
    // fact. The caller records only after its existing live object checks pass.
    sourceGated: {
      playwrightChildRetained: true,
      observerChildAssociation: observation !== undefined,
      retainedSpawnHandshake: observation?.authority.kind === 'retained-spawn',
      readerChildAssociation: true,
      rootMainRawIds: true,
      readerRawIdsGroupsCapabilities: {
        uid: Array(4).fill(reader.scope.uid),
        gid: Array(4).fill(reader.scope.gid),
        groups: [],
        capabilities: {
          inheritable: '0000000000000000',
          permitted: '0000000000000000',
          effective: '0000000000000000',
          ambient: '0000000000000000',
        },
      },
      readerArgvAndCleanEnvironment: true,
      pendingSavedBeforeSpawn: true,
      childSavedBeforeAcknowledgement: true,
      exactReadyAcknowledgementAndInputEOF: true,
      repeatedCredentials: true,
      canonicalStableBoundedFiles: true,
      initAndGateWrites: true,
      outputFramingExitAndBothEOF: true,
      originalExpiration: true,
      processAncestryAndEffectiveProfiles: true,
    },
    unknown: [
      'rawCredentialTranscript',
      'parserExecutableVersionAndBytes',
      'includedTunablesAndAliases',
      'mountedFileDescriptorIdentities',
      'transportEventTimes',
    ],
  };
}

// Each bounded snapshot finishes synchronously under the smoke callback's
// ownership. There is no detached write, timer race, retry or new helper budget.
// A write failure poisons acceptance even if the caller catches the exception.
export function managedEvidenceLog(path, write = writeFileSync) {
  let failed = false,
    cleanup,
    correlation,
    installation;
  const launches = [];
  const reject = () => {
    failed = true;
    refuse();
  };
  const persist = () => {
    if (failed) refuse();
    try {
      const text = JSON.stringify({
        schema: 1,
        launches,
        cleanup: cleanup ?? null,
      });
      if (Buffer.byteLength(text) > 65536) refuse();
      write(path, text);
    } catch (error) {
      failed = true;
      throw error;
    }
  };
  return {
    launch(installed, request, observation) {
      if (
        failed ||
        cleanup ||
        launches.length >= 2 ||
        (launches.length === 0) !== (observation !== undefined)
      )
        reject();
      let evidence;
      try {
        evidence = managedLaunchEvidence(installed, request, observation);
      } catch (error) {
        failed = true;
        throw error;
      }
      correlation ??= evidence.correlationSha256;
      installation ??= evidence.installationSha256;
      if (
        correlation !== evidence.correlationSha256 ||
        installation !== evidence.installationSha256
      )
        reject();
      launches.push(evidence);
      persist();
      return JSON.parse(JSON.stringify(evidence));
    },
    cleanup(value, request) {
      if (
        failed ||
        cleanup ||
        !validManagedResponse({ ok: true, value }, request) ||
        !value.removed ||
        (correlation && value.audit.correlationSha256 !== correlation)
      )
        reject();
      cleanup = JSON.parse(JSON.stringify(value.audit));
      persist();
    },
    result() {
      if (
        failed ||
        launches.length !== 2 ||
        !cleanup ||
        cleanup.prior.reader.length !== 2 ||
        !cleanup.parserRemoval ||
        cleanup.resourcesRemoved.length !== 3 ||
        cleanup.receiptSha256 !== launches[1]?.receiptSha256
      )
        reject();
      const last = launches[1];
      for (const [observed, expected] of [
        [cleanup.prior.writer, last.parserAdd.writer],
        [cleanup.prior.reader[0], last.reader.writer],
        [cleanup.prior.reader[1], last.reader.child],
      ]) {
        if (
          !Object.keys(expected).every((key) => observed[key] === expected[key])
        )
          reject();
      }
      return JSON.parse(JSON.stringify({ schema: 1, launches, cleanup }));
    },
  };
}
