# Gates: D26 append-only staff tenant and user notes (C125)

OWNS: apps/platform-api/src/deletion/platform-deletion.integration.spec.ts, apps/platform-api/src/deletion/retention-expiry.integration.spec.ts, apps/platform-web/src/features/admin/components/admin-note-composer.tsx, apps/platform-api/src/admin-tenants/**, apps/platform-api/src/admin-users/**, apps/platform-api/src/db/migrations/0035_admin_notes.sql, apps/platform-api/src/db/migrations/rollback/0035_remove_admin_notes.sql, apps/platform-api/src/db/migrations/meta/_journal.json, apps/platform-web/src/api/live-admin-tenants.ts, apps/platform-web/src/api/live-admin-users.ts, apps/platform-web/src/api/services/admin-tenants.ts, apps/platform-web/src/api/services/admin-users.ts, apps/platform-web/src/features/admin/pages/tenants/tenant-detail.tsx, apps/platform-web/src/features/admin/pages/users/user-detail.tsx, apps/platform-web/src/features/admin/pages/tenants/tenant-notes.spec.tsx, apps/platform-web/src/features/admin/pages/users/user-notes.spec.tsx, scripts/gates/baseline.json, docs/work-queue.md

Scope: Authenticated staff can append bounded notes to tenant and user action history. Existing immutable history and retention remain authoritative; tenant read/write retains active support-grant scope. Notes are immutable local staff history; mandatory central staff audit is acknowledged before local commit, and failed audit rolls back the note. D26 tenant detail metrics, review assignment, billing operations and deployments remain independently required. No vendor write is needed.

- [ ] G1: Real ordinary-role PostgreSQL persists tenant/user notes as immutable staff history with mandatory central audit acknowledgement before commit; audit failure rolls back, note updates/deletes fail, and existing action history and retention remain intact
  CHECK: node .unlazy/verify-storage.mjs
  EXPECT: admin-notes-storage-passed
  EVIDENCE: pending

- [ ] G2: Real staff-cookie HTTP applies current roles and tenant support-grant scope; missing, expired, unrelated and revoked access cannot read or append notes; unknown subjects and invalid notes return errors
  CHECK: node .unlazy/verify-http.mjs
  EXPECT: admin-notes-http-passed
  EVIDENCE: pending

- [ ] G3: Live and demo tenant/user pages append and refresh actual history; validation, role limitations and unavailable service remain visible
  CHECK: node .unlazy/verify-web.mjs
  EXPECT: admin-notes-web-passed
  EVIDENCE: pending

- [ ] G4: Old-code and fault controls fail then restored code passes; full API/web tests, coverage, static, migration rollback, erasure/retention and architecture/RBAC/AST checks pass
  CHECK: node .unlazy/verify-final.mjs
  EXPECT: admin-notes-final-passed
  EVIDENCE: pending
