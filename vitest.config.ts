import { defineConfig } from "vitest/config";

// Used by every `vitest run <paths>` started from the repository root without
// --config (most projects' test targets). Only turns env-file loading off --
// see C35 in apps/platform-api/vitest.config.ts; everything else is Vitest's
// default.
export default defineConfig({
  // C35: never read .env files. Vite 8's loadEnv loops forever on a
  // self-referencing default (PLATFORM_DB_PORT=${PLATFORM_DB_PORT:-5432},
  // which .env.local.example uses for shell overrides) once another variable
  // references it, so any run with the repository's .env.local present hung.
  // Tests get their environment explicitly, as CI does.
  envDir: false,
});
