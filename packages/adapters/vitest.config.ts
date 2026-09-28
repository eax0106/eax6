import { defineConfig } from "vitest/config";

export default defineConfig({
  // C35: never read .env files. Vite 8's loadEnv loops forever on a
  // self-referencing default (PLATFORM_DB_PORT=${PLATFORM_DB_PORT:-5432},
  // which .env.local.example uses for shell overrides) once another variable
  // references it, so any run with the repository's .env.local present hung.
  // Tests get their environment explicitly, as CI does.
  envDir: false,
  test: {
    include: ["packages/adapters/src/**/*.spec.ts"],
    hookTimeout: 120_000,
    testTimeout: 120_000,
    coverage: {
      provider: "v8",
      reportsDirectory: "packages/adapters/coverage",
      include: [
        "packages/adapters/src/aws/secrets-manager-provider.ts",
        "packages/adapters/src/grpc/audit-grpc-transport.ts",
        "packages/adapters/src/postgres/audit-store-provider.ts",
        "packages/adapters/src/postgres/orchestration-store-provider.ts",
        "packages/adapters/src/temporal/durable-execution-provider.ts",
      ],
      thresholds: {
        branches: 90,
        lines: 90,
      },
    },
  },
});
