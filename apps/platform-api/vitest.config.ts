import { defineConfig } from "vitest/config";

export default defineConfig({
  // C35: never read .env files. Vite 8's loadEnv loops forever on a
  // self-referencing default (PLATFORM_DB_PORT=${PLATFORM_DB_PORT:-5432},
  // which .env.local.example uses for shell overrides) once another variable
  // references it, so any run with the repository's .env.local present hung.
  // Tests get their environment explicitly, as CI does.
  envDir: false,
  test: {
    env: {
      MARKETPLACE_SEARCH_CURSOR_SECRET: "test-search-cursor-secret",
    },
    include: [
      "apps/platform-api/src/**/*.spec.ts",
      "tests/integration/rbac/**/*.spec.ts",
      "tests/integration/marketplace/**/*.spec.ts",
      "tests/integration/security-review/**/*.spec.ts",
      "tests/integration/tenant-activity/**/*.spec.ts",
    ],
    exclude: [
      "apps/platform-api/src/marketplace/**/*.integration.spec.ts",
      "apps/platform-api/src/publisher/**/*.integration.spec.ts",
      "apps/platform-api/src/registry/**/*.integration.spec.ts",
      "apps/platform-api/src/marketplace-governance/**/*.integration.spec.ts",
      // search's was the one marketplace-schema integration spec missing from
      // this list and from the test-db-integration target -- so it ran here,
      // against a real database, alongside the unit specs. It is in that
      // target now, like its three siblings above.
      "apps/platform-api/src/search/**/*.integration.spec.ts",
      "apps/platform-api/src/db/db.migration.spec.ts",
      // Runs in test-db-integration, not here: several DB-backed specs in
      // parallel vitest workers exhaust platform-db and time each other out.
      "apps/platform-api/src/db/marketplace-migrator.integration.spec.ts",
      "apps/platform-api/src/db/platform-db-schema-completeness.spec.ts",
      "apps/platform-api/src/identity/**/*.integration.spec.ts",
      "apps/platform-api/src/signup/**/*.integration.spec.ts",
      "apps/platform-api/src/idempotency/**/*.integration.spec.ts",
      "apps/platform-api/src/credentials/**/*.integration.spec.ts",
      "apps/platform-api/src/env-vars/**/*.integration.spec.ts",
      "apps/platform-api/src/admin-users/**/*.integration.spec.ts",
      "apps/platform-api/src/billing/**/*.integration.spec.ts",
      "apps/platform-api/src/admin-tenants/**/*.integration.spec.ts",
      "apps/platform-api/src/entitlements/**/*.integration.spec.ts",
    ],
    coverage: {
      provider: "v8",
      all: true,
      // Real CI-only reporter override: the default "text" reporter prints
      // a full colored per-file table (~140 covered files here), which was
      // crashing the CI runner mid-write (deterministic OOM-kill at the
      // same row every run, not a real test failure -- 982/982 tests pass
      // every time before this). text-summary keeps threshold enforcement
      // identical (it reads the coverage map, not the printed format) and
      // json/lcov are still written for tooling.
      reporter: process.env.CI ? ["text-summary", "json", "lcov"] : ["text", "html", "clover", "json"],
    include: [
        "apps/platform-api/src/marketplace/**/*.ts",
        "apps/platform-api/src/publisher/**/*.ts",
        "apps/platform-api/src/registry/**/*.ts",
        "apps/platform-api/src/db/**/*.ts",
        "apps/platform-api/src/identity/**/*.ts",
        "apps/platform-api/src/rbac/**/*.ts",
        "apps/platform-api/src/identity-broker/**/*.ts",
        "apps/platform-api/src/entitlements/**/*.ts",
        "apps/platform-api/src/abuse/**/*.ts",
        "apps/platform-api/src/signup/**/*.ts",
        "apps/platform-api/src/tenants/**/*.ts",
        "apps/platform-api/src/workspaces/**/*.ts",
        "apps/platform-api/src/members/**/*.ts",
        "apps/platform-api/src/onboarding/**/*.ts",
        "apps/platform-api/src/engine/**/*.ts",
        "apps/platform-api/src/idempotency/**/*.ts",
        "apps/platform-api/src/concurrency/**/*.ts",
        "apps/platform-api/src/streaming/**/*.ts",
        "apps/platform-api/src/workflows/**/*.ts",
        "apps/platform-api/src/projects/**/*.ts",
        "apps/platform-api/src/runs/**/*.ts",
        "apps/platform-api/src/action-centre/**/*.ts",
        "apps/platform-api/src/credentials/**/*.ts",
        "apps/platform-api/src/env-vars/**/*.ts",
        "apps/platform-api/src/ads/**/*.ts",
        "apps/platform-api/src/integrations/**/*.ts",
        "apps/platform-api/src/triggers/**/*.ts",
        "apps/platform-api/src/billing/**/*.ts",
        "apps/platform-api/src/credit-purchases/**/*.ts",
        "apps/platform-api/src/discovery/**/*.ts",
        "apps/platform-api/src/publisher/**/*.ts",
        "apps/platform-api/src/admin-tenants/**/*.ts",
        "apps/platform-api/src/admin-policy/**/*.ts",
      ],
      exclude: [
        "apps/platform-api/src/db/**/*.spec.ts",
        "apps/platform-api/src/identity/**/*.spec.ts",
        "apps/platform-api/src/rbac/**/*.spec.ts",
        "apps/platform-api/src/identity-broker/**/*.spec.ts",
        "apps/platform-api/src/entitlements/**/*.spec.ts",
        "apps/platform-api/src/abuse/**/*.spec.ts",
        "apps/platform-api/src/signup/**/*.spec.ts",
        "apps/platform-api/src/tenants/**/*.spec.ts",
        "apps/platform-api/src/workspaces/**/*.spec.ts",
        "apps/platform-api/src/members/**/*.spec.ts",
        "apps/platform-api/src/onboarding/**/*.spec.ts",
        "apps/platform-api/src/engine/**/*.spec.ts",
        "apps/platform-api/src/idempotency/**/*.spec.ts",
        "apps/platform-api/src/concurrency/**/*.spec.ts",
        "apps/platform-api/src/streaming/**/*.spec.ts",
        "apps/platform-api/src/workflows/**/*.spec.ts",
        "apps/platform-api/src/projects/**/*.spec.ts",
        "apps/platform-api/src/runs/**/*.spec.ts",
        "apps/platform-api/src/action-centre/**/*.spec.ts",
        "apps/platform-api/src/credentials/**/*.spec.ts",
        "apps/platform-api/src/env-vars/**/*.spec.ts",
        "apps/platform-api/src/ads/**/*.spec.ts",
        "apps/platform-api/src/integrations/**/*.spec.ts",
        "apps/platform-api/src/triggers/**/*.spec.ts",
        "apps/platform-api/src/billing/**/*.spec.ts",
        "apps/platform-api/src/credit-purchases/**/*.spec.ts",
        "apps/platform-api/src/credit-purchases/testing/**/*.ts",
        "apps/platform-api/src/discovery/**/*.spec.ts",
        "apps/platform-api/src/admin-tenants/**/*.spec.ts",
        "apps/platform-api/src/admin-policy/**/*.spec.ts",
      ],
      thresholds: {
        lines: 90,
        "apps/platform-api/src/db/**/*.ts": {
          lines: 90,
        },
        "apps/platform-api/src/identity/**/*.ts": {
          lines: 90,
          branches: 90,
        },
        "apps/platform-api/src/rbac/**/*.ts": {
          lines: 90,
          branches: 90,
        },
        "apps/platform-api/src/identity-broker/**/*.ts": {
          lines: 90,
          branches: 90,
        },
        "apps/platform-api/src/{entitlements,abuse}/**/*.ts": {
          lines: 85,
          branches: 85,
        },
        "apps/platform-api/src/signup/**/*.ts": {
          lines: 85,
          branches: 85,
        },
        "apps/platform-api/src/tenants/**/*.ts": {
          lines: 85,
          branches: 85,
        },
        "apps/platform-api/src/workspaces/**/*.ts": {
          lines: 85,
          branches: 85,
        },
        "apps/platform-api/src/members/**/*.ts": {
          lines: 85,
          branches: 85,
        },
        "apps/platform-api/src/onboarding/**/*.ts": {
          lines: 80,
          branches: 75,
        },
        "apps/platform-api/src/engine/**/*.ts": {
          lines: 90,
          branches: 90,
        },
        "apps/platform-api/src/idempotency/**/*.ts": {
          lines: 90,
          branches: 90,
        },
        "apps/platform-api/src/concurrency/**/*.ts": {
          lines: 90,
          branches: 90,
        },
        "apps/platform-api/src/streaming/**/*.ts": {
          lines: 85,
          branches: 80,
        },
        "apps/platform-api/src/streaming/{revocation,stream-gateway}.ts": {
          lines: 90,
          branches: 90,
        },
        "apps/platform-api/src/workflows/**/*.ts": {
          lines: 85,
          branches: 80,
        },
        "apps/platform-api/src/workflows/{workflow.controller,workflow.service}.ts": {
          lines: 90,
          branches: 90,
        },
        "apps/platform-api/src/projects/**/*.ts": {
          lines: 85,
          branches: 80,
        },
        "apps/platform-api/src/projects/{project.controller,project.service,project-operations.controller,project-operations.service}.ts": {
          lines: 90,
          branches: 90,
        },
        "apps/platform-api/src/runs/**/*.ts": {
          lines: 85,
          branches: 80,
        },
        "apps/platform-api/src/runs/{run.controller,run.service}.ts": {
          lines: 85,
          branches: 80,
        },
        "apps/platform-api/src/action-centre/**/*.ts": {
          lines: 85,
          branches: 80,
        },
        "apps/platform-api/src/action-centre/{action-centre.controller,action-centre.service}.ts": {
          lines: 90,
          branches: 90,
        },
        "apps/platform-api/src/credentials/**/*.ts": {
          lines: 85,
          branches: 80
        },
        "apps/platform-api/src/credentials/{credential.service,credential.repository}.ts": {
          lines: 90,
          branches: 90
        },
        "apps/platform-api/src/env-vars/**/*.ts": {
          lines: 85,
          branches: 80
        },
        "apps/platform-api/src/env-vars/{env-var.controller,env-var.service,env-var.repository}.ts": {
          lines: 90,
          branches: 90
        },
        "apps/platform-api/src/ads/**/*.ts": {
          lines: 85,
          branches: 80
        },
        "apps/platform-api/src/integrations/**/*.ts": {
          lines: 85,
          branches: 80
        },
        "apps/platform-api/src/triggers/**/*.ts": {
          lines: 85,
          branches: 80
        },
        "apps/platform-api/src/triggers/{trigger.controller,trigger.service,trigger-etag.resolver}.ts": {
          lines: 90,
          branches: 90
        },
        "apps/platform-api/src/billing/**/*.ts": {
          lines: 85,
          branches: 80
        },
        "apps/platform-api/src/credit-purchases/**/*.ts": {
          lines: 85,
          branches: 80
        },
        "apps/platform-api/src/billing/{billing.service,billing.repository}.ts": {
          lines: 90,
          branches: 90
        },
        "apps/platform-api/src/discovery/**/*.ts": {
          lines: 80,
          branches: 75,
        },
        "apps/platform-api/src/admin-tenants/**/*.ts": {
          lines: 85,
          branches: 80,
        },
        "apps/platform-api/src/admin-policy/**/*.ts": {
          lines: 85,
          branches: 80,
        },
      },
    },
  },
});
