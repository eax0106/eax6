# Gates: D21 registry package scanning and first-version review (C119)

OWNS: .dockerignore, apps/platform-api/src/rbac/rbac.guard.ts, apps/platform-api/project.json, apps/platform-api/vitest.config.ts, apps/platform-web/src/api/live-admin-commerce.ts, apps/platform-web/src/api/live-admin-commerce.spec.ts, apps/platform-api/src/config/env.schema.spec.ts, apps/platform-api/src/db/marketplace-migrator.integration.spec.ts, apps/platform-api/src/db/marketplace-migration-files.spec.ts, docs/specs/07-env-config-spec.md, packages/shared-clients/src/package-scan.ts, packages/shared-clients/src/index.ts, packages/adapters/src/osv/**, packages/adapters/src/index.ts, apps/platform-api/src/registry/**, apps/platform-api/src/marketplace-governance/**, apps/platform-api/src/db/marketplace-migrations/0007_tool_version_review.sql, apps/platform-api/src/db/marketplace-migrations/rollback/0007_drop_tool_version_review.sql, apps/platform-api/src/config/env.schema.ts, docker/Dockerfile.node, apps/platform-web/src/api/services/marketplace-admin.ts, apps/platform-web/src/api/services/marketplace-admin.spec.ts, apps/platform-web/src/features/admin/pages/platform/marketplace-admin.tsx, apps/platform-web/src/features/admin/pages/platform/marketplace-admin.spec.tsx, docs/package-scanning.md, docs/work-queue.md, scripts/gates/baseline.json

Scope: OSV-Scanner behind the existing scanner port scans the actual uploaded artifact's pinned dependencies without executing package code. A missing scanner, empty package extraction, malformed output, failed lookup or timeout cannot produce a clean report. Every first published tool version needs a staff review of its exact clean scan. Later versions require a clean scan. Existing tenant policies, registry permissions and normal publishing controls remain enforced. Socket integration stays deferred under D21.

- [ ] G1: The real OSV executable scans controlled clean and affected dependency fixtures; JSON findings preserve package identity, advisory identity and severity, while scanner/error/no-package outcomes remain nonclean
  CHECK: node .unlazy/verify-scanner.mjs
  EXPECT: package-scanner-passed
  EVIDENCE: pending

- [ ] G2: Artifact reading is scoped to the owning tenant and configured object store; bounded archive extraction rejects traversal, links and oversized input, never runs package scripts, and removes temporary files after success or failure
  CHECK: node .unlazy/verify-artifacts.mjs
  EXPECT: package-artifacts-passed
  EVIDENCE: pending

- [ ] G3: Ordinary PostgreSQL and actual public guards enforce first-version staff approval of the exact clean scan, later-version clean scans, audit/review attribution, concurrent publication and idempotent retries
  CHECK: node .unlazy/verify-native.mjs
  EXPECT: package-review-native-passed
  EVIDENCE: pending

- [ ] G4: Existing staff review UI lists awaiting versions, shows scan findings, submits an attributed decision and preserves failed/conflicting edits; live and mock adapters match
  CHECK: node .unlazy/verify-web.mjs
  EXPECT: package-review-web-passed
  EVIDENCE: pending

- [ ] G5: Distinct production mutations fail real behavioral assertions and restored sources pass
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: package-scanner-controls-passed
  EVIDENCE: pending

- [ ] G6: Full touched suites and coverage, static checks, actual production scanner wiring, pinned executable image recipe, CI discovery, paired rollback, boundaries/RBAC/naming and zero added normalized AST findings pass
  CHECK: node .unlazy/verify-final.mjs
  EXPECT: package-scanner-final-passed
  EVIDENCE: pending
