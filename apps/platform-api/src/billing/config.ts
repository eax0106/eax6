export function billingDatabaseFromEnvironment(environment: NodeJS.ProcessEnv): string | undefined {
  return environment.DATABASE_URL;
}

/** Single-identity local development remains supported; EC2 provides both identities. */
export function billingOperationsDatabaseFromEnvironment(environment: NodeJS.ProcessEnv): string | undefined {
  return environment.OPERATIONS_PLATFORM_DATABASE_URL || environment.DATABASE_URL;
}
