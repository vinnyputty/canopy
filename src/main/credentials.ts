import { spawnSync } from 'node:child_process';

export type SecretServiceStatus = 'available' | 'unavailable' | 'unknown';

type CommandResult = {
  status: number | null;
  error?: { code?: string };
  signal?: NodeJS.Signals | null;
  stderr?: string;
  stdout?: string;
};

type Command = (file: string, args: string[]) => CommandResult;

export type CredentialStoreSelection =
  | { action: 'unchanged'; reason: 'not-linux' | 'command-line' | 'desktop' }
  | { action: 'libsecret'; reason: 'secret-service' }
  | {
      action: 'unchanged';
      reason: 'secret-service-unavailable' | 'secret-service-unknown';
    };

let configuredSelection: CredentialStoreSelection | undefined;

function command(file: string, args: string[]): CommandResult {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    timeout: 1_000,
    windowsHide: true,
  });
  return {
    status: result.status,
    error: result.error as { code?: string } | undefined,
    signal: result.signal,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function outcome(result: CommandResult): SecretServiceStatus {
  if (result.status === 0) return 'available';
  const reply = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (
    /ServiceUnknown|NameHasNoOwner|org\.freedesktop\.secrets.*not provided/i.test(
      reply,
    )
  )
    return 'unavailable';
  return 'unknown';
}

/**
 * Checks whether a session Secret Service responds, activating it if supported. The
 * process timeout keeps startup responsive when a session bus is unavailable.
 */
export function secretServiceStatus(
  run: Command = command,
): SecretServiceStatus {
  const calls: [string, string[]][] = [
    [
      'dbus-send',
      [
        '--session',
        '--dest=org.freedesktop.secrets',
        '--type=method_call',
        '--print-reply',
        '--reply-timeout=1000',
        '/org/freedesktop/secrets',
        'org.freedesktop.DBus.Peer.Ping',
      ],
    ],
    [
      'gdbus',
      [
        'call',
        '--session',
        '--dest',
        'org.freedesktop.secrets',
        '--object-path',
        '/org/freedesktop/secrets',
        '--method',
        'org.freedesktop.DBus.Peer.Ping',
      ],
    ],
  ];
  for (const [file, args] of calls) {
    const current = outcome(run(file, args));
    if (current !== 'unknown') return current;
  }
  return 'unknown';
}

function hasPasswordStoreArgument(argv: readonly string[]) {
  return argv.some(
    (argument) =>
      argument === '--password-store' ||
      argument.startsWith('--password-store='),
  );
}

function establishedDesktop(environment: NodeJS.ProcessEnv) {
  const desktop = `${environment.XDG_CURRENT_DESKTOP ?? ''}:${
    environment.DESKTOP_SESSION ?? ''
  }`.toLowerCase();
  return /gnome|kde|plasma/.test(desktop);
}

/** Configure libsecret before Electron is ready on a nonstandard desktop. */
export function configureLinuxCredentialStore(
  setPasswordStore: (store: 'gnome-libsecret') => void,
  options: {
    platform?: NodeJS.Platform;
    argv?: readonly string[];
    environment?: NodeJS.ProcessEnv;
    probe?: () => SecretServiceStatus;
  } = {},
): CredentialStoreSelection {
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux')
    return (configuredSelection = { action: 'unchanged', reason: 'not-linux' });
  const argv = options.argv ?? process.argv;
  if (hasPasswordStoreArgument(argv))
    return (configuredSelection = {
      action: 'unchanged',
      reason: 'command-line',
    });
  const environment = options.environment ?? process.env;
  if (establishedDesktop(environment))
    return (configuredSelection = { action: 'unchanged', reason: 'desktop' });
  const status = (options.probe ?? secretServiceStatus)();
  if (status === 'available') {
    setPasswordStore('gnome-libsecret');
    return (configuredSelection = {
      action: 'libsecret',
      reason: 'secret-service',
    });
  }
  return (configuredSelection = {
    action: 'unchanged',
    reason:
      status === 'unavailable'
        ? 'secret-service-unavailable'
        : 'secret-service-unknown',
  });
}

export function linuxCredentialStorageError(
  selection = configuredSelection,
  backend?: string,
) {
  if (backend === 'basic_text' && selection?.reason === 'secret-service')
    return 'A Secret Service keyring is available, but Electron selected its insecure basic backend. Restart Canopy with --password-store=gnome-libsecret.';
  switch (selection?.reason) {
    case 'secret-service':
      return 'A Secret Service keyring is available, but libsecret could not provide encryption. Unlock the keyring and check that libsecret is installed, then restart Canopy.';
    case 'command-line':
      return 'Secure credential storage is unavailable because the selected --password-store backend did not provide encryption. Start a desktop keyring, then choose its backend.';
    case 'secret-service-unavailable':
      return 'Secure credential storage is unavailable because no Secret Service keyring was found. Start and unlock GNOME Keyring or KeePassXC, then restart Canopy.';
    case 'secret-service-unknown':
      return 'Secure credential storage is unavailable. Canopy could not determine whether your session has a Secret Service keyring. If your keyring is running, restart Canopy with --password-store=gnome-libsecret; otherwise start and unlock GNOME Keyring or KeePassXC first.';
    case 'desktop':
      return 'Secure credential storage is unavailable from this desktop keyring. Unlock or configure the keyring, then restart Canopy.';
    default:
      return 'Secure credential storage is unavailable. Start and unlock your desktop keyring, then restart Canopy.';
  }
}
