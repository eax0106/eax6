import { defineConfig } from "vitest/config";

export default defineConfig({
  // C35: never read .env files. Vite 8's loadEnv loops forever on a
  // self-referencing default (PLATFORM_DB_PORT=${PLATFORM_DB_PORT:-5432},
  // which .env.local.example uses for shell overrides) once another variable
  // references it, so any run with the repository's .env.local present hung.
  // Tests get their environment explicitly, as CI does.
  envDir: false,
  test: {
    include: ["apps/audit-service/src/**/*.spec.ts"],
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 120_000,
    coverage: {
      provider: "v8",
      reportsDirectory: "apps/audit-service/coverage",
      include: [
        "apps/audit-service/src/audit/**/*.ts",
        "apps/audit-service/src/config/**/*.ts",
        "apps/audit-service/src/database/**/*.ts",
        "apps/audit-service/src/deletion/**/*.ts",
        "apps/audit-service/src/health/**/*.ts"
      ],
      exclude: ["apps/audit-service/src/**/*.spec.ts"],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90
      }
    }
  }
});
