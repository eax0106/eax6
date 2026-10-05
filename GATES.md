# Gates: D27 marketplace reviewer changes and real-signal risk (C127)

OWNS: apps/platform-api/vitest.config.ts, apps/platform-api/src/config/env.schema.ts, tests/integration/marketplace/governance-audit.spec.ts, apps/platform-api/src/marketplace-governance/**, apps/platform-api/src/marketplace/**, apps/platform-api/src/publisher/**, apps/platform-api/src/registry/**, apps/platform-api/src/db/marketplace-migrations/0008_marketplace_governance.sql, apps/platform-api/src/db/marketplace-migrations/rollback/0008_remove_marketplace_governance.sql, apps/platform-api/src/db/marketplace-migrator.spec.ts, apps/platform-api/src/db/marketplace-migration-files.spec.ts, apps/platform-api/src/db/marketplace-migrator.integration.spec.ts, packages/deletion-registry/src/declaration.ts, apps/platform-api/src/deletion/**, packages/contracts/src/operations.ts, packages/contracts/src/operations.spec.ts, apps/platform-web/src/api/live-admin-commerce.ts, apps/platform-web/src/api/live-admin-commerce.spec.ts, apps/platform-web/src/api/services/marketplace-admin.ts, apps/platform-web/src/api/services/seller.ts, apps/platform-web/src/api/services/marketplace.ts, apps/platform-web/src/api/types.ts, apps/platform-web/src/api/mock/marketplace-governance.ts, apps/platform-web/src/features/admin/pages/platform/marketplace-admin.tsx, apps/platform-web/src/features/admin/pages/platform/marketplace-admin.spec.tsx, apps/platform-web/src/features/seller/pages/**, apps/platform-web/src/features/assets/pages/**, apps/platform-web/src/api/**marketplace**spec.ts, scripts/gates/baseline.json, docs/marketplace-governance.md, docs/work-queue.md

Scope: Complete D27 needs-changes with attributed reviewer notes, seller edits and resubmission into review; audited transitions retain reasons. Review risk derives from actual current scan, first-listing, declared outside actions/account scopes and recorded reports/takedowns, exposes its reasons, orders review and never makes approval decisions. Preserve D21 exact scan/version review and D22 free-only publication. Marketplace migration0008 follows existing tool-version review0007. C122 billing and C125 notes run concurrently; integrate applicable main changes before final verification.

- [x] G1: Ordinary-role PostgreSQL preserves immutable attributed reviewer notes and audited locked transitions; needs-changes returns to review only after authorized seller resubmission, stale and unrelated writes fail, and failed audit commits no transition
  CHECK: node .unlazy/verify-governance-storage.mjs
  EXPECT: marketplace-governance-storage-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=2c56c548e34279cba8877e6edf5b407340dbbc8ddc72a11dfa8ac8bbb78f36a7; exit=0; EXPECT=matched; output-sha256=a7b2e19b450e388d393e4059a00d0f16655cea9b097e4cc677f2013672ddc4bf; output-bytes=92; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-marketplace-governance-c127; path=2b1f1cc87037/31 entries

- [x] G2: Risk uses only recorded current scanner verdict, actual first-listing history, declared outside actions/account scopes and prior reports/takedowns; reasons explain contributions, missing signals remain explicit and risk never changes publication status
  CHECK: node .unlazy/verify-governance-risk.mjs
  EXPECT: marketplace-governance-risk-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=cf66aa59fdad3899e85726dbb19f00743c79dc95c02c8706483a836b20f50b90; exit=0; EXPECT=matched; output-sha256=be753f05664019fbec2d5ac5cdf45a5b997de5253db0a97a840ea4bcde217a6b; output-bytes=152; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-marketplace-governance-c127; path=2b1f1cc87037/31 entries

- [x] G3: Actual current staff-cookie and tenant-session HTTP enforce existing roles and ownership for review, notes and resubmission; normal scanner review and free-only publication retain their requirements
  CHECK: node .unlazy/verify-governance-http.mjs
  EXPECT: marketplace-governance-http-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=2979a7723c68849e6955d9245707628040f69cbc0f07e0c09fc66b4afc524cb6; exit=0; EXPECT=matched; output-sha256=5ac26f1fd22aadaf64775869d9fc2163bba5659ac5e27f90f84d5c70c39f722d; output-bytes=101; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-marketplace-governance-c127; path=2b1f1cc87037/31 entries

- [x] G4: Live and demo reviewer/seller pages show risk with reasons and reviewer notes, submit bounded reasons, edit and resubmit the actual listing, and preserve failures and conflicts without fabricated success
  CHECK: node .unlazy/verify-governance-web.mjs
  EXPECT: marketplace-governance-web-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=e3860110f9941b5ce5b0becc233a8749a03238c19ba8b915cd37035a344cea69; exit=0; EXPECT=matched; output-sha256=75c2c7c6f392f092a056ccfb6e8c88bba3db44c6524f41c3edf4ededbe42a5a7; output-bytes=88; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-marketplace-governance-c127; path=2b1f1cc87037/31 entries

- [x] G5: Meaningful original/fault/restored controls prove the outcomes; full affected suites, coverage, static, actual migrations/rollback, erasure/retention and architecture/RBAC/AST checks pass on the integrated final source
  CHECK: node .unlazy/verify-governance-final.mjs
  EXPECT: marketplace-governance-final-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=c40c399dd8b6a16941bfbc324d9fc3443b3584f379dcfa34ab3bb1e9ca9f8d45; exit=0; EXPECT=matched; output-sha256=6b7d22a01a9e2e9593b19f06dd908a1802f1a20b18297339d38a368e6d40b4f8; output-bytes=998; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-marketplace-governance-c127; path=2b1f1cc87037/31 entries
