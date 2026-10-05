/** Verify the synthetic audit's exact Playwright prefix before the app path. */
export function auditArguments(argv: string[], platform: string): string[] {
  const prefix = [
    ...(platform === 'linux' && argv.at(-1) !== '--no-sandbox'
      ? ['--no-sandbox']
      : []),
    '--inspect=0',
    '--remote-debugging-port=0',
  ];
  const args = argv.slice(1);
  if (args[0] === prefix[0]) {
    if (!prefix.every((value, i) => args[i] === value))
      throw new Error('Unexpected audit launch prefix.');
    const application = args.slice(prefix.length);
    if (!application[0] || application[0].startsWith('--'))
      throw new Error('Unexpected audit launch prefix.');
    return [argv[0], ...application];
  }
  // Direct duplicate launches retain the ordinary production argument contract.
  if (args[0]?.startsWith('--'))
    throw new Error('Unexpected audit launch prefix.');
  return argv;
}

/** Intercept the sample's actual main copy dispatch, without reading native data. */
export function installSampleCopySink(clipboard: object) {
  if (![Object.prototype, null].includes(Object.getPrototypeOf(clipboard)))
    throw new Error('Unknown clipboard method ownership.');
  const originals = Object.getOwnPropertyDescriptors(clipboard);
  if (
    Reflect.ownKeys(clipboard).some((key) => typeof key !== 'string') ||
    typeof originals.writeText?.value !== 'function' ||
    Object.values(originals).some(
      (d) => d.get || d.set || !d.configurable || typeof d.value !== 'function',
    )
  )
    throw new Error('Clipboard cannot be isolated before sample copy.');
  let copied: string | undefined;
  let count = 0;
  let active = true;
  const installed: Record<string, PropertyDescriptor> = {};
  const matches = (name: string, d: PropertyDescriptor) => {
    const current = Object.getOwnPropertyDescriptor(clipboard, name);
    return (
      current?.value === d.value &&
      current?.writable === d.writable &&
      current?.enumerable === d.enumerable &&
      current?.configurable === d.configurable
    );
  };
  const verify = () => {
    if (
      !active ||
      Reflect.ownKeys(clipboard).length !== Object.keys(installed).length ||
      Object.entries(installed).some(([name, d]) => !matches(name, d))
    )
      throw new Error('Sample copy isolation changed.');
  };
  const restore = () => {
    if (!active) return;
    active = false;
    let changed = false;
    for (const [name, original] of Object.entries(originals)) {
      if (!installed[name]) continue;
      if (matches(name, installed[name]))
        Object.defineProperty(clipboard, name, original);
      else changed = true;
    }
    if (changed) throw new Error('Sample clipboard method ownership changed.');
  };
  try {
    for (const [name, original] of Object.entries(originals)) {
      const value =
        name === 'writeText'
          ? (text: unknown, ...extra: unknown[]) => {
              verify();
              if (
                typeof text !== 'string' ||
                text.length > 100_000 ||
                extra.length ||
                count
              )
                throw new Error('Invalid sample copy.');
              copied = text;
              count++;
            }
          : () => {
              throw new Error(
                'Native clipboard access denied in sample audit.',
              );
            };
      const descriptor = { ...original, value };
      Object.defineProperty(clipboard, name, descriptor);
      installed[name] = descriptor;
    }
    verify();
  } catch (error) {
    try {
      restore();
    } catch {
      /* Keep the installation failure primary. */
    }
    throw error;
  }
  return {
    inspect() {
      verify();
      return { count, text: copied };
    },
    restore,
  };
}

/** Permanent process-local refusals in the disposable manual fixture. */
export function denySampleExternalAccess(shell: object, target: object) {
  const methods = [
    { object: shell, key: 'openExternal' },
    { object: target, key: 'fetch' },
  ];
  const descriptors = methods.map(({ object, key }) =>
    Object.getOwnPropertyDescriptor(object, key),
  );
  if (
    descriptors.some(
      (d) =>
        !d?.configurable || d.get || d.set || typeof d.value !== 'function',
    )
  )
    throw new Error('Sample external access cannot be isolated.');
  for (const [index, { object, key }] of methods.entries())
    Object.defineProperty(object, key, {
      value: () =>
        Promise.reject(new Error('External access denied in sample audit.')),
      writable: false,
      configurable: false,
      enumerable: descriptors[index]!.enumerable,
    });
}
