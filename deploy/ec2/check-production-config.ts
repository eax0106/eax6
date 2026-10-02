// Task 6.1d. Proves, without a host, that the .env bootstrap.sh writes lets
// the services start with NODE_ENV=production. Several components refuse a
// mock in production and only find out at boot: platform-api's identity,
// email and media providers, its environment schema, and orchestration's
// Session Gateway. This runs each one's own selection code -- not a copy --
// against each container's own environment, as `docker compose config`
// resolves it from the generated .env and compose.yml (env_file plus any
// per-service overrides). Clients are only constructed; nothing is called.
//
// Usage: pnpm exec tsx --tsconfig apps/platform-api/tsconfig.app.json \
//          deploy/ec2/check-production-config.ts <compose config JSON>
// (deploy/ec2/check-production-boot.sh produces the JSON). Prints
// "production-config-ok" or one line per failure and exits 1.
import { readFileSync } from "node:fs";

import {
  resolveEmailProvider,
  resolveImageGenProvider,
  resolveMediaObjectStorageProvider,
  resolveSpeechToTextProvider,
  resolveTextToSpeechProvider,
} from "@alterx/adapters";

const file = process.argv[2];
if (!file) {
  console.error("usage: check-production-config.ts <compose config JSON>");
  process.exit(2);
}
const services = (JSON.parse(readFileSync(file, "utf8")) as {
  services: Record<string, { environment?: Record<string, string | null> }>;
}).services;
const baseline = { ...process.env };

/** Makes process.env exactly what the named container would see. */
function asService(name: string): void {
  const environment = services[name]?.environment;
  if (!environment) throw new Error(`compose has no service ${name}`);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { PATH: baseline.PATH, HOME: baseline.HOME });
  for (const [key, value] of Object.entries(environment)) if (value !== null) process.env[key] = value;
}

async function main(): Promise<void> {
  const failures: string[] = [];
  const check = async (service: string, name: string, run: () => unknown): Promise<void> => {
    try {
      asService(service);
      if (process.env.NODE_ENV !== "production") throw new Error(`NODE_ENV is ${process.env.NODE_ENV}, not production`);
      await run();
    } catch (error) {
      failures.push(`${service} ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const { validatePlatformApiEnv } = await import("../../apps/platform-api/src/config/env.schema");
  const { createIdentityProvider } = await import("../../apps/platform-api/src/identity/identity.module");
  const { InMemorySessionStore } = await import("../../apps/platform-api/src/identity/session-store");
  const { InMemorySsoConfigStore } = await import("../../apps/platform-api/src/identity/sso-config-store");
  const { sessionGatewayEnvironment, buildWorstCaseEstimator } = await import(
    "../../apps/orchestration-service/src/orchestration-infrastructure.module"
  );

  await check("platform-api", "environment", () => validatePlatformApiEnv(process.env));
  for (const value of [undefined, "postgresql://platform_app:fixture@localhost/platform_db"]) {
    await check("platform-api", "retention configuration control", () => {
      const environment: NodeJS.ProcessEnv = Object.assign({}, process.env);
      if (value === undefined) delete environment.PLATFORM_RETENTION_DATABASE_URL;
      else environment.PLATFORM_RETENTION_DATABASE_URL = value;
      try { validatePlatformApiEnv(environment); }
      catch (error) {
        if (error instanceof Error && error.message.includes("PLATFORM_RETENTION_DATABASE_URL")) return;
        throw error;
      }
      throw new Error("invalid retention configuration accepted");
    });
  }
  await check("platform-api", "identity provider", () =>
    createIdentityProvider(new InMemorySessionStore(), new InMemorySsoConfigStore()),
  );
  for (const service of ["platform-api", "tool-gateway"]) {
    await check(service, "email provider", () => resolveEmailProvider(async () => ""));
  }
  await check("platform-api", "media providers", () => {
    const objects = resolveMediaObjectStorageProvider();
    resolveImageGenProvider(objects);
    resolveTextToSpeechProvider(objects);
    resolveSpeechToTextProvider(objects);
  });
  await check("orchestration-service", "Session Gateway", () => sessionGatewayEnvironment(process.env));
  await check("orchestration-service", "pre-run estimation", () => buildWorstCaseEstimator(process.env));
  const { runLearningAuditClient } = await import(
    "../../apps/orchestration-service/src/runs/run-learning-audit"
  );
  // C46: service-asserted tenants are audited; real mode needs audit-service.
  await check("orchestration-service", "audit client", () => runLearningAuditClient(process.env));
  const { engineConfigFromEnvironment } = await import("../../apps/platform-api/src/engine/config");
  await check("platform-api", "Engine clients", () => engineConfigFromEnvironment(process.env));

  // Pairs whose halves live in different containers: each must agree.
  const env = (service: string, key: string) => services[service]?.environment?.[key] ?? undefined;
  for (const key of ["APPCONFIG_APPLICATION_ID", "APPCONFIG_ENVIRONMENT_ID", "APPCONFIG_CONFIGURATION_PROFILE_ID"]) {
    if (!env("orchestration-service", key) || env("orchestration-service", key) !== env("model-gateway", key)) {
      failures.push(`orchestration-service ${key} must match model-gateway`);
    }
  }
  if (env("orchestration-service", "COST_LEDGER_BASE_URL") !== `http://127.0.0.1:${env("cost-ledger-service", "COST_PORT")}`) {
    failures.push("orchestration-service COST_LEDGER_BASE_URL must use cost-ledger-service's host-network port");
  }
  const sha256 = async (value: string) => (await import("node:crypto")).createHash("sha256").update(value).digest("hex");
  const pairs: [string, string, string, string][] = [
    ["platform-api", "EVAL_FACADE_TOKEN", "orchestration-service", "EVAL_FACADE_TOKEN_SHA256"],
    ["platform-api", "DEPLOYMENT_ADMIN_SERVICE_TOKEN", "orchestration-service", "DEPLOYMENT_ADMIN_SERVICE_TOKEN_SHA256"],
    ["platform-api", "CONNECTION_REGISTRY_SERVICE_TOKEN", "orchestration-service", "CONNECTION_REGISTRY_SERVICE_TOKEN_SHA256"],
    ["platform-api", "INTERNAL_SERVICE_TOKEN", "ads-core", "INTERNAL_SERVICE_TOKEN_SHA256"],
  ];
  for (const [caller, tokenKey, receiver, hashKey] of pairs) {
    const token = env(caller, tokenKey);
    const hash = env(receiver, hashKey);
    if (!token || !hash || (await sha256(token)) !== hash) {
      failures.push(`${caller} ${tokenKey} does not match ${receiver} ${hashKey}`);
    }
  }
  if (env("platform-api", "AUDIT_QUERY_SERVICE_TOKEN_REF") !== env("audit-service", "DELETION_SERVICE_TOKEN_REF")) {
    failures.push("platform-api AUDIT_QUERY_SERVICE_TOKEN_REF is not audit-service's DELETION_SERVICE_TOKEN_REF");
  }
  if (env("platform-api", "ADS_CORE_SERVICE_TOKEN_REF") !== "env:INTERNAL_SERVICE_TOKEN") {
    failures.push("platform-api ADS_CORE_SERVICE_TOKEN_REF does not name the token ads-core checks");
  }
  if (env("platform-api", "CONNECTION_REGISTRY_SERVICE_TOKEN_REF") !== "env:CONNECTION_REGISTRY_SERVICE_TOKEN") {
    failures.push("platform-api CONNECTION_REGISTRY_SERVICE_TOKEN_REF does not name the registry token");
  }
  const jwks = env("orchestration-service", "ACTOR_TOKEN_JWKS_URL") ?? "";
  if (!jwks.startsWith(`http://127.0.0.1:${env("platform-api", "PLATFORM_API_PORT")}/`)) {
    failures.push(`orchestration-service ACTOR_TOKEN_JWKS_URL ${jwks} is not platform-api's port ${env("platform-api", "PLATFORM_API_PORT")}`);
  }

  if (failures.length > 0) {
    for (const failure of failures) console.log(`FAIL ${failure}`);
    process.exit(1);
  }
  console.log("production-config-ok");
}

void main();
