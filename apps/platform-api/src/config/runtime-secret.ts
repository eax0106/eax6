export async function resolveRuntimeSecret(reference: string): Promise<string> {
  const key = reference.startsWith("env:") ? reference.slice(4) : reference;
  const value = process.env[key];
  if (!value) throw new Error(`Secret reference unavailable: ${reference}`);
  return value;
}
