/** Database configuration is resolved at the module boundary. */
export function deploymentAdminDatabaseFromEnvironment(environment:NodeJS.ProcessEnv):string|undefined{return environment.DATABASE_URL;}
