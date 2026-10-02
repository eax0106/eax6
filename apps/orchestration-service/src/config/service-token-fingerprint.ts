export function loadServiceTokenFingerprint(
  environment: NodeJS.ProcessEnv,
  field: string,
): string {
  const normalized = environment[field]?.trim() ?? "";
  if (!/^[0-9a-f]{64}$/i.test(normalized)) {
    throw new Error(`${field} must be a 64-character SHA-256 fingerprint`);
  }
  return normalized;
}
