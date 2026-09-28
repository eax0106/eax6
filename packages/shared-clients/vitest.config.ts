import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // C35: never read .env files. Vite 8's loadEnv loops forever on a
  // self-referencing default (PLATFORM_DB_PORT=${PLATFORM_DB_PORT:-5432},
  // which .env.local.example uses for shell overrides) once another variable
  // references it, so any run with the repository's .env.local present hung.
  // Tests get their environment explicitly, as CI does.
  envDir: false,
  resolve: {
    alias: {
      "@alterx/contracts": fileURLToPath(
        new URL("../contracts/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/shared-clients/src/**/*.spec.ts"],
  },
});
