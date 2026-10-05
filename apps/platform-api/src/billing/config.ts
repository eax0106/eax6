export function billingDatabaseFromEnvironment(environment:NodeJS.ProcessEnv):string|undefined{return environment.DATABASE_URL;}
