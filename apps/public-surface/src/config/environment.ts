import { resolve } from "node:path";
import { createEnvironmentValidators, type PostgresOrchestrationStoreConfig } from "@alterx/adapters";
import { PublicFormTokenCodec } from "@alterx/auth";

const { requireValue, parsePort } = createEnvironmentValidators((field, reason) => new Error(`${field} ${reason}`));
export function loadPublicSurfaceEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const tokenKey = requireValue(environment, "PUBLIC_FORM_TOKEN_KEY"), codec = new PublicFormTokenCodec(tokenKey);
  const origin = new URL(requireValue(environment, "PUBLIC_FORM_BASE_URL"));
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
      !(origin.protocol === "https:" || (origin.protocol === "http:" && local && environment.NODE_ENV !== "production"))) throw new Error("Public form base URL must be an HTTPS origin");
  const authentication = requireValue(environment, "PUBLIC_SURFACE_DATABASE_AUTHENTICATION");
  const migrationsFolder = resolve("apps/orchestration-service/drizzle");
  const region = requireValue(environment, "AWS_REGION");
  let database: PostgresOrchestrationStoreConfig;
  if (authentication === "static") database = { authentication, migrationsFolder, connectionString: requireValue(environment, "PUBLIC_SURFACE_DATABASE_URL") };
  else if (authentication === "iam") database = { authentication, migrationsFolder, region, user: "public_surface",
    host: requireValue(environment, "PUBLIC_SURFACE_DATABASE_HOST"), port: parsePort(environment.PUBLIC_SURFACE_DATABASE_PORT, "PUBLIC_SURFACE_DATABASE_PORT", 5432),
    database: requireValue(environment, "PUBLIC_SURFACE_DATABASE_NAME") };
  else throw new Error("PUBLIC_SURFACE_DATABASE_AUTHENTICATION must be static or iam");
  const redisUrl = requireValue(environment, "PUBLIC_SURFACE_REDIS_URL");
  if (!["redis:", "rediss:"].includes(new URL(redisUrl).protocol)) throw new Error("Public Surface requires Redis");
  return { tokenKey, codec, database, region, redisUrl, origin: origin.origin, hostname: origin.hostname,
    siteKey: requireValue(environment, "PUBLIC_FORM_TURNSTILE_SITE_KEY"), turnstileSecretRef: requireValue(environment, "PUBLIC_FORM_TURNSTILE_SECRET_REF"),
    modelGatewayAddress: requireValue(environment, "MODEL_GATEWAY_ADDRESS"), busName: requireValue(environment, "EVENTBRIDGE_BUS_NAME"),
    eventBridgeEndpoint: environment.EVENTBRIDGE_ENDPOINT?.trim() || undefined,
    port: parsePort(environment.PUBLIC_SURFACE_PORT, "PUBLIC_SURFACE_PORT", 3021),
    pageLimits: { form: positive(environment.PUBLIC_FORM_PAGE_FORM_LIMIT, 120), visitor: positive(environment.PUBLIC_FORM_PAGE_VISITOR_LIMIT, 30), windowSeconds: 60 },
    submitLimits: { form: positive(environment.PUBLIC_FORM_SUBMIT_FORM_LIMIT, 60), visitor: positive(environment.PUBLIC_FORM_SUBMIT_VISITOR_LIMIT, 10), windowSeconds: 60 },
  };
}
function positive(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error("Public form rate limits must be positive integers");
  return result;
}
