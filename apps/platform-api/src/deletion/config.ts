export function erasureAdministrationReferenceFromEnvironment(environment: NodeJS.ProcessEnv): string {
  return environment.OPERATIONS_PLATFORM_DATABASE_URL ? "env:OPERATIONS_PLATFORM_DATABASE_URL" : "env:DATABASE_URL";
}
