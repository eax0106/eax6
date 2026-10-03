export function memoryServiceConnection(environment: NodeJS.ProcessEnv = process.env) {
  const address = environment["MEMORY_SERVICE_ADDRESS"]?.trim();
  const authorization = environment["MEMORY_SERVICE_AUTHORIZATION"]?.trim();
  if (!address || !authorization?.startsWith("Bearer ") || !authorization.slice(7).trim()) return undefined;
  return { address, authorization };
}
