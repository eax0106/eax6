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
  const { sessionGatewayEnvironment } = await import(
    "../../apps/orchestration-service/src/orchestration-infrastructure.module"
  );

  await check("platform-api", "environment", () => validatePlatformApiEnv(process.env));
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

  if (failures.length > 0) {
    for (const failure of failures) console.log(`FAIL ${failure}`);
    process.exit(1);
  }
  console.log("production-config-ok");
}

void main();
