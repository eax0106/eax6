# Gates: D27 marketplace reviewer changes and real-signal risk (C127)

OWNS: apps/platform-api/src/marketplace-governance/**, apps/platform-api/src/marketplace/**, apps/platform-api/src/publisher/**, apps/platform-api/src/db/marketplace-migrations/0008_marketplace_governance.sql, apps/platform-api/src/db/marketplace-migrations/rollback/0008_remove_marketplace_governance.sql, apps/platform-api/src/db/marketplace-migrator.spec.ts, packages/deletion-registry/src/declaration.ts, apps/platform-api/src/deletion/**, packages/contracts/src/operations.ts, packages/contracts/src/operations.spec.ts, apps/platform-web/src/api/live-admin-commerce.ts, apps/platform-web/src/api/services/marketplace-admin.ts, apps/platform-web/src/api/services/seller.ts, apps/platform-web/src/api/services/marketplace.ts, apps/platform-web/src/features/admin/pages/platform/marketplace-admin.tsx, apps/platform-web/src/features/admin/pages/platform/marketplace-admin.spec.tsx, apps/platform-web/src/features/seller/pages/**, apps/platform-web/src/api/**marketplace**spec.ts, scripts/gates/baseline.json, docs/marketplace-governance.md, docs/work-queue.md

Scope: Complete D27 needs-changes with attributed reviewer notes, seller edits and resubmission into review; audited transitions retain reasons. Review risk derives from actual current scan, first-listing, declared outside actions/account scopes and recorded reports/takedowns, exposes its reasons, orders review and never makes approval decisions. Preserve D21 exact scan/version review and D22 free-only publication. Marketplace migration0008 follows existing tool-version review0007. C122 billing and C125 notes run concurrently; integrate applicable main changes before final verification.

- [ ] G1: Ordinary-role PostgreSQL preserves immutable attributed reviewer notes and audited locked transitions; needs-changes returns to review only after authorized seller resubmission, stale and unrelated writes fail, and failed audit commits no transition
  CHECK: node .unlazy/verify-governance-storage.mjs
  EXPECT: marketplace-governance-storage-passed
  EVIDENCE: pending

- [ ] G2: Risk uses only recorded current scanner verdict, actual first-listing history, declared outside actions/account scopes and prior reports/takedowns; reasons explain contributions, missing signals remain explicit and risk never changes publication status
  CHECK: node .unlazy/verify-governance-risk.mjs
  EXPECT: marketplace-governance-risk-passed
  EVIDENCE: pending

- [ ] G3: Actual current staff-cookie and tenant-session HTTP enforce existing roles and ownership for review, notes and resubmission; normal scanner review and free-only publication retain their requirements
  CHECK: node .unlazy/verify-governance-http.mjs
  EXPECT: marketplace-governance-http-passed
  EVIDENCE: pending

- [ ] G4: Live and demo reviewer/seller pages show risk with reasons and reviewer notes, submit bounded reasons, edit and resubmit the actual listing, and preserve failures and conflicts without fabricated success
  CHECK: node .unlazy/verify-governance-web.mjs
  EXPECT: marketplace-governance-web-passed
  EVIDENCE: pending

- [ ] G5: Meaningful original/fault/restored controls prove the outcomes; full affected suites, coverage, static, actual migrations/rollback, erasure/retention and architecture/RBAC/AST checks pass on the integrated final source
  CHECK: node .unlazy/verify-governance-final.mjs
  EXPECT: marketplace-governance-final-passed
  EVIDENCE: pending
