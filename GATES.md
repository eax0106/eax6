# Gates: D26 append-only staff tenant and user notes (C125)

OWNS: apps/platform-api/src/deletion/platform-deletion.integration.spec.ts, apps/platform-api/src/deletion/retention-expiry.integration.spec.ts, apps/platform-web/src/features/admin/components/admin-note-composer.tsx, apps/platform-api/src/admin-tenants/**, apps/platform-api/src/admin-users/**, apps/platform-api/src/db/migrations/0035_admin_notes.sql, apps/platform-api/src/db/migrations/rollback/0035_remove_admin_notes.sql, apps/platform-api/src/db/migrations/meta/_journal.json, apps/platform-web/src/api/live-admin-tenants.ts, apps/platform-web/src/api/live-admin-users.ts, apps/platform-web/src/api/services/admin-tenants.ts, apps/platform-web/src/api/services/admin-users.ts, apps/platform-web/src/features/admin/pages/tenants/tenant-detail.tsx, apps/platform-web/src/features/admin/pages/users/user-detail.tsx, apps/platform-web/src/features/admin/pages/tenants/tenant-notes.spec.tsx, apps/platform-web/src/features/admin/pages/users/user-notes.spec.tsx, scripts/gates/baseline.json, docs/work-queue.md

Scope: Authenticated staff can append bounded notes to tenant and user action history. Existing immutable history and retention remain authoritative; tenant read/write retains active support-grant scope. Notes are immutable local staff history; mandatory central staff audit is acknowledged before local commit, and failed audit rolls back the note. D26 tenant detail metrics, review assignment, billing operations and deployments remain independently required. No vendor write is needed.

- [x] G1: Real ordinary-role PostgreSQL persists tenant/user notes as immutable staff history with mandatory central audit acknowledgement before commit; audit failure rolls back, note updates/deletes fail, and existing action history and retention remain intact
  CHECK: node .unlazy/verify-storage.mjs
  EXPECT: admin-notes-storage-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=d4ec974c4e6ff1f64425cc4b2105a316ed6e5159a733a92c0a250ad0fbbdae87; exit=0; EXPECT=matched; output-sha256=3072481478a022a163048983d7338be8cef94afe90f7823d17d4e07ea3675a2a; output-bytes=81; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-admin-notes-c125; path=2b1f1cc87037/31 entries

- [x] G2: Real staff-cookie HTTP applies current roles and tenant support-grant scope; missing, expired, unrelated and revoked access cannot read or append notes; unknown subjects and invalid notes return errors
  CHECK: node .unlazy/verify-http.mjs
  EXPECT: admin-notes-http-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=65ca83c977eab453c7a0b255092d40738a922732ea9d89c27ccea7f909c8de97; exit=0; EXPECT=matched; output-sha256=81de062d61d035073ab939a7c27d4ca4867676e75a7b5949409f26aee41cec2c; output-bytes=78; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-admin-notes-c125; path=2b1f1cc87037/31 entries

- [x] G3: Live and demo tenant/user pages append and refresh actual history; validation, role limitations and unavailable service remain visible
  CHECK: node .unlazy/verify-web.mjs
  EXPECT: admin-notes-web-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=198a8758c4e38e9dd496c3d39b823f2b4bfb94fffd12f0cfd1078f780bcd63b3; exit=0; EXPECT=matched; output-sha256=fe8447dc37b3d62c1c5a9f4700cb5759908ec8c4ce657aa4fc1d7fd430b7947c; output-bytes=77; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-admin-notes-c125; path=2b1f1cc87037/31 entries

- [x] G4: Old-code and fault controls fail then restored code passes; full API/web tests, coverage, static, migration rollback, erasure/retention and architecture/RBAC/AST checks pass
  CHECK: node .unlazy/verify-final.mjs
  EXPECT: admin-notes-final-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=68a032aa1b0fe4f6c1e849a062006fd241b8ec0ff8ecb25bef77a964fddf8a36; exit=0; EXPECT=matched; output-sha256=e92e0c37fd724368ae271b32f3f1f103b5ea112bb1cab37c36446e80ce2c94a4; output-bytes=751; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-admin-notes-c125; path=2b1f1cc87037/31 entries
