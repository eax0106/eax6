import { defineConfig } from "vitest/config";

export default defineConfig({
  // C35: never read .env files. Vite 8's loadEnv loops forever on a
  // self-referencing default (PLATFORM_DB_PORT=${PLATFORM_DB_PORT:-5432},
  // which .env.local.example uses for shell overrides) once another variable
  // references it, so any run with the repository's .env.local present hung.
  // Tests get their environment explicitly, as CI does.
  envDir: false,
  test: {
    include: ["apps/cost-ledger-service/src/**/*.spec.ts"],
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 120_000,
    coverage: {
      provider: "v8",
      reportsDirectory: "apps/cost-ledger-service/coverage",
      include: [
        "apps/cost-ledger-service/src/config/**/*.ts",
        "apps/cost-ledger-service/src/database/**/*.ts",
        "apps/cost-ledger-service/src/estimation/**/*.ts",
        "apps/cost-ledger-service/src/health/**/*.ts",
        "apps/cost-ledger-service/src/ingest/**/*.ts",
      ],
      exclude: ["apps/cost-ledger-service/src/**/*.spec.ts"],
    },
  },
});
