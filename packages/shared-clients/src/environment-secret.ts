/** Resolve environment references without importing an application module or reading global configuration. */
export function resolveEnvironmentSecret(reference: string, environment: Readonly<Record<string, string | undefined>>): string {
  const key = reference.startsWith("env:") ? reference.slice(4) : reference;
  const value = environment[key];
  if (!value) throw new Error(`Secret reference unavailable: ${reference}`);
  return value;
}
