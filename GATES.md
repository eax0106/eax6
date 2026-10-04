# Gates: D21 registry package scanning and first-version review (C119)

OWNS: .dockerignore, apps/platform-api/src/db/marketplace-migrator.spec.ts, apps/platform-api/src/rbac/rbac.guard.ts, apps/platform-api/project.json, apps/platform-api/vitest.config.ts, apps/platform-web/src/api/live-admin-commerce.ts, apps/platform-web/src/api/live-admin-commerce.spec.ts, apps/platform-api/src/config/env.schema.spec.ts, apps/platform-api/src/db/marketplace-migrator.integration.spec.ts, apps/platform-api/src/db/marketplace-migration-files.spec.ts, docs/specs/07-env-config-spec.md, packages/shared-clients/src/package-scan.ts, packages/shared-clients/src/index.ts, packages/adapters/src/osv/**, packages/adapters/src/index.ts, apps/platform-api/src/registry/**, apps/platform-api/src/marketplace-governance/**, apps/platform-api/src/db/marketplace-migrations/0007_tool_version_review.sql, apps/platform-api/src/db/marketplace-migrations/rollback/0007_drop_tool_version_review.sql, apps/platform-api/src/config/env.schema.ts, docker/Dockerfile.node, apps/platform-web/src/api/services/marketplace-admin.ts, apps/platform-web/src/api/services/marketplace-admin.spec.ts, apps/platform-web/src/features/admin/pages/platform/marketplace-admin.tsx, apps/platform-web/src/features/admin/pages/platform/marketplace-admin.spec.tsx, docs/package-scanning.md, docs/work-queue.md, scripts/gates/baseline.json

Scope: OSV-Scanner behind the existing scanner port scans the actual uploaded artifact's pinned dependencies without executing package code. A missing scanner, empty package extraction, malformed output, failed lookup or timeout cannot produce a clean report. Every first published tool version needs a staff review of its exact clean scan. Later versions require a clean scan. Existing tenant policies, registry permissions and normal publishing controls remain enforced. Socket integration stays deferred under D21.

- [x] G1: The real OSV executable scans controlled clean and affected dependency fixtures; JSON findings preserve package identity, advisory identity and severity, while scanner/error/no-package outcomes remain nonclean
  CHECK: node .unlazy/verify-scanner.mjs
  EXPECT: package-scanner-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=1c464ebac85fcb19888568a83e27885b3497600b78f0e53893c1d892dc0c08a8; exit=0; EXPECT=matched; output-sha256=9c3fafcf1df88fde5ffb58dfeacad4d587f34081edbbedc9a0cb747ea955b504; output-bytes=78; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-package-scanner-c119; path=2b1f1cc87037/31 entries

- [x] G2: Artifact reading is scoped to the owning tenant and configured object store; bounded archive extraction rejects traversal, links and oversized input, never runs package scripts, and removes temporary files after success or failure
  CHECK: node .unlazy/verify-artifacts.mjs
  EXPECT: package-artifacts-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=5e05d58ea49b3967c262342ed1f6eb8b6d695b3d23087a31644d1080e7d25313; exit=0; EXPECT=matched; output-sha256=5bf55b0c51c9725730512bd1922e1da99c1adef8772c170282124b3f22365c74; output-bytes=90; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-package-scanner-c119; path=2b1f1cc87037/31 entries

- [x] G3: Ordinary PostgreSQL and actual public guards enforce first-version staff approval of the exact clean scan, later-version clean scans, audit/review attribution, concurrent publication and idempotent retries
  CHECK: node .unlazy/verify-native.mjs
  EXPECT: package-review-native-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=55e6d448ea7d83963ed7aaf10f7cac475ae2556e8f8c94005e18b729b53268bb; exit=0; EXPECT=matched; output-sha256=ab4e6f24968cbeb230ff467977360795710c53bbdbf6fd0b5aa0aa59d00fcd37; output-bytes=83; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-package-scanner-c119; path=2b1f1cc87037/31 entries

- [x] G4: Existing staff review UI lists awaiting versions, shows scan findings, submits an attributed decision and preserves failed/conflicting edits; live and mock adapters match
  CHECK: node .unlazy/verify-web.mjs
  EXPECT: package-review-web-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=4d191f8eaf6c827a9d4bb5be9d684b4d89700de9f3354366d11e9586beb8249b; exit=0; EXPECT=matched; output-sha256=71a4698d6cf41bcb8ffe651233687ccac04b6cec041ebeee0da4e11799b3e9b9; output-bytes=80; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-package-scanner-c119; path=2b1f1cc87037/31 entries

- [x] G5: Distinct production mutations fail real behavioral assertions and restored sources pass
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: package-scanner-controls-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=9ee9930ae3d6a89a4350d90a25dc91038c652ef8cdc756ee13aa27fdbca6501f; exit=0; EXPECT=matched; output-sha256=38c3de1982158c25b137526e208c36df41f6e03394350c2809de4c6985cf58dc; output-bytes=2359; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-package-scanner-c119; path=2b1f1cc87037/31 entries

- [x] G6: Full touched suites and coverage, static checks, actual production scanner wiring, pinned executable image recipe, CI discovery, paired rollback, boundaries/RBAC/naming and zero added normalized AST findings pass
  CHECK: node .unlazy/verify-final.mjs
  EXPECT: package-scanner-final-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=9ecdfdb25566ad52c31ef0578d0868ebe3cdb38abf1bdc346dc1c9471f70ac11; exit=0; EXPECT=matched; output-sha256=0449e75385ea6034ff5eee12b3dd68e5a95fbd43eda5ebb68706b9365ae9a119; output-bytes=905; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-package-scanner-c119; path=2b1f1cc87037/31 entries
