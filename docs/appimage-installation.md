# Managed AppImage installation design

Managed installation and policy preparation are **unimplemented and unqualified**. CI continues to launch the original download directly with the existing strict sandbox and identity checks. A managed installation is a candidate for restricted-user-namespace Ubuntu hosts; it does not establish support for unmanaged portable execution or satisfy native acceptance.

## Policy contract and its limits

[Ubuntu security documentation](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/#apparmor-unprivileged-user-namespace-restrictions) requires an application profile to permit unprivileged user namespaces. [Ubuntu's application-profile guidance](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces) recommends vendors ship profiles attached to their installation paths. The [Ubuntu 24.04 release notes](https://discourse.ubuntu.com/t/ubuntu-24-04-lts-noble-numbat-release-notes/39890) describe `flags=(unconfined)` with `userns,` as an application-specific permission.

A proposed profile attaches only to the immutable original runtime:

```apparmor
abi <abi/4.0>,
include <tunables/global>
profile canopy-appimage /opt/Canopy/Canopy.AppImage flags=(unconfined) {
  userns,
}
```

This grants namespace access to the named profile; it is not a filesystem confinement profile. Children can inherit its permission. The exact attachment path alone does not limit permission to one executable throughout the process tree.

[AppArmor's kernel domain-transition implementation](https://github.com/torvalds/linux/blob/v6.8/security/apparmor/domain.c) retains the current unconfined profile on exec when no other attachment matches, and changes labels when another profile attaches. This is conditional inheritance, not a guarantee for every installed interpreter or runtime. The [upstream AppArmor inheritance report](https://gitlab.com/apparmor/apparmor/-/issues/527) describes the same behavior, but a report is not proof of Canopy's effective label on a particular runner.

Canopy's `AppRun` uses a Bash interpreter and execs the mounted payload. A successful profile load or permission on the original AppImage therefore cannot alone establish permission in the actual FUSE-mounted Electron process. The runner's loaded profiles, exec transitions and effective process context must be checked. A SUID-helper fatal message does not establish mounted helper ownership/mode or an AppArmor denial.

## Installation and launch requirements

A future implementation must retain these requirements:

- Copy the original artifact to `/opt/Canopy/Canopy.AppImage`, preserving its exact SHA-256 and executable bytes. Require root ownership and no group/other write permission on the file and every parent; reject symlinks and unexpected existing destinations. Do not change mounted or extracted helper ownership or SUID permissions.
- Create an exclusive root-owned installation receipt binding the source artifact hash, destination identity, exact profile content/hash and resources created by this installation. Refuse any existing profile file or loaded profile with the same name; do not replace another installation's policy.
- Load only the exact app-specific profile. Verify its loaded identity and attach it through ordinary-user execution of the fixed original runtime. Keep global AppArmor/sysctl settings, mounting semantics, format selection, Chromium arguments and launch deadlines intact.
- Bind the sole actual direct launch to its retained `ChildProcess`, parent, birth, UID and canonical original executable before accepting mounted evidence. Validate live FUSE executable/ASAR hashes, mount identity, helper containment and effective AppArmor context across exec. A cached command, PID, expected hash or extracted tree is insufficient.
- Verify sandbox-enabled first-run and restart with the same credential-free isolated profile, persisted appearance, renderer `NoNewPrivs: 1`/`Seccomp: 2`, and executable/ASAR identity. Preserve fail-closed behavior when policy, FUSE, launch binding or sandbox checks fail.
- On every attempted installation, use bounded cleanup tied to the receipt. Remove only owned, unchanged resources and unload only the installation's exact profile after the launch is finished. Refuse mismatched ownership, paths, identity or policy content. Preserve a primary failure if cleanup fails; cleanup failure after otherwise successful checks fails the gate.

Privileged preparation would be confined to an explicitly guarded disposable GitHub-hosted Linux runner after fresh source/security approval. It must refuse ordinary local and self-hosted execution. Source tests must cover exact profile/receipt contents, original-copy provenance, path/ownership and collision refusal, partial failures, bounded cleanup and primary-error preservation using owned Node-only fixtures. These tests cannot qualify real policy attachment or secure AppImage startup.

## Unresolved prerequisites

The source now implements a scoped retained-spawn handshake for the sole existing first launch. Node's constructor notification supplies no PID authority; the successful event on the actual returned `ChildProcess` must match the exact direct-launch executable and arguments. A private nonce-bound observer checks parent/process birth and ordinary-user UID, then requests confirmation while the parent still retains that live handle. Duplicate, late, foreign, exited or disconnected handoffs remain unknown. The ten-second total observer budget and existing launch/restart budgets are unchanged.

Fast-exec acceptance requires the original at the fixed root-owned, non-writable managed path with protected parents, matching original SHA-256 and stable file identity. It records `retained-spawn` authority, not a claim that `/proc` showed the original ELF before exec. Executable-file ownership is separate from the launch user's process ownership. Ordinary owned downloads still require seeing the native original before exec and can remain unknown when that observation is missed. Mounted ELF/ASAR hashes, FUSE identity, helper containment and effective context checks remain required.

This is source-only implementation, with Node child/IPC and controlled Linux I/O fixtures. No managed installer, root-owned artifact receipt or policy preparation has been implemented or executed. The policy attachment, inherited context and actual secure managed launch require fresh independent source/security review and genuine hosted evidence. Unmanaged portability, native clean installation, upgrade/removal, desktop integration, unlocked keyring and signing trust remain pending.
