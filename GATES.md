# Gates: D7 workspace invitations and fixed roles (C121)

OWNS: tests/integration/rbac/workspace-invitations.spec.ts, apps/platform-api/src/streaming/membership-revocation.integration.spec.ts, apps/platform-api/src/members/**, apps/platform-api/src/identity/**, apps/platform-api/src/signup/**, apps/platform-api/src/config/env.schema.ts, apps/platform-api/src/config/env.schema.spec.ts, apps/platform-api/src/db/migrations/0033_workspace_invitations.sql, apps/platform-api/src/db/migrations/rollback/0033_drop_workspace_invitations.sql, apps/platform-api/src/db/migrations/meta/_journal.json, apps/platform-api/src/db/schema/**, apps/platform-api/src/db/db.migration.spec.ts, apps/platform-api/src/db/platform-db-schema-completeness.spec.ts, apps/platform-api/project.json, apps/platform-api/src/deletion/**, apps/platform-api/src/workspaces/**, packages/deletion-registry/src/**, apps/platform-web/src/api/**, apps/platform-web/src/features/members/**, apps/platform-web/src/features/settings/pages/security-settings.tsx, apps/platform-web/src/features/settings/pages/security-settings.spec.tsx, apps/platform-web/src/features/auth/**, apps/platform-web/src/layout/workspace-switcher.tsx, apps/platform-web/src/features/permissions/**, apps/platform-web/src/features/events/pages/event-detail.spec.tsx, apps/platform-web/src/features/connections/pages/whatsapp-channel.spec.tsx, apps/platform-web/src/features/roles/**, docs/members.md, docs/work-queue.md, scripts/gates/baseline.json, deploy/ec2/**, .env.local.example

Scope: D7 hybrid invites use Alter's tenant-scoped invitation record as authority and Auth0 organization invitations for delivery. Verified callback accepts a current unexpired invitation into its selected workspace and fixed role. Resend/revoke protect races. Existing five enforced workspace roles and tenant owner badge appear in live/mock UI; role changes are audited and cannot alter owner or demote/remove last admin. Password reset remains with selected identity provider. No custom roles or third-party message outside explicit invitation/reset action.

- [x] G1: Ordinary PostgreSQL enforces invitation tenant/workspace scope, seven-day expiry, uniqueness and erasure; paired migration and rollback preserve other memberships
  CHECK: node .unlazy/verify-store.mjs
  EXPECT: members-store-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=e293fe4f2013b792523da941c247926589fefad2b763f71019f20ef5a38851c3; exit=0; EXPECT=matched; output-sha256=8da992749e4935bcbc0a24826482560f9972e7c22c09386805d13d2794f3d369; output-bytes=227; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-members-c121; path=2b1f1cc87037/31 entries

- [x] G2: Auth0 organization invitation creation/cancellation and password-reset requests use documented provider APIs; mock mirrors lifecycle and unavailable/invalid provider responses never report sent
  CHECK: node .unlazy/verify-provider.mjs
  EXPECT: members-provider-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=a9138fd53cbdbdced2fb0327e33af41b55f416c953eb83e64e21a411f4a52f5d; exit=0; EXPECT=matched; output-sha256=5d051886709df51b3a267dbdc809fff9beaa0ca0f20b2c6f6801d38ea71d545a; output-bytes=78; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-members-c121; path=2b1f1cc87037/31 entries

- [x] G3: Authenticated routes create/list/resend/revoke invitations only in managed workspaces; concurrent operations and failed delivery leave truthful statuses and attributed audit records
  CHECK: node .unlazy/verify-invitations.mjs
  EXPECT: members-invitations-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=e7a3ae7714338fccbdf0691109880a04cd273bb5540da38064aa4a619eaebfe3; exit=0; EXPECT=matched; output-sha256=fb8ea16546dd07604c08819bf38225241bb5b07cdf13b0778fdad0d1352229a0; output-bytes=145; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-members-c121; path=2b1f1cc87037/31 entries

- [x] G4: Real callback accepts only verified matching identity into a current pending invitation, creates correct tenant/workspace membership once, and refuses revoked/expired/foreign invitations before issuing access
  CHECK: node .unlazy/verify-callback.mjs
  EXPECT: members-callback-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=dbe512bd959586642f274f6bebee65500f1ac19b209cd8e3b606e173811f4520; exit=0; EXPECT=matched; output-sha256=9edc248b2ad335619899bd7db23f0ffec6cf0f0c5dca4000ff2dd3d1cd017816; output-bytes=196; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-members-c121; path=2b1f1cc87037/31 entries

- [x] G5: Workspace role updates/removal enforce five fixed roles, caller workspace admin rights, immutable tenant owner and last-admin protection under concurrency; audit and immediate access revocation persist
  CHECK: node .unlazy/verify-roles.mjs
  EXPECT: members-roles-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=8d8eb15810d3e567bf4a4068a5ac193736bd03d35c48755f4ad7bb37a5ccebbc; exit=0; EXPECT=matched; output-sha256=d3650d11d4367e842b07d32fccd60a4ea89776e71b176fa9ee4f61e767feaae1; output-bytes=87; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-members-c121; path=2b1f1cc87037/31 entries

- [x] G6: Live/mock/rendered UI uses actual workspace, displays current members/pending invites and owner badge, supports five roles/resend/revoke/role changes/password reset, and keeps errors visible without fabricated success
  CHECK: node .unlazy/verify-web.mjs
  EXPECT: members-web-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=216283b0acc4540ab3c6d6bc24ef57e9f7ff2576fe62a87bb18468cfa6f2f62a; exit=0; EXPECT=matched; output-sha256=941d90e64d63b22bafec85d1b0e079088f01d3301a6849bce9fea06c0230c9eb; output-bytes=154; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-members-c121; path=2b1f1cc87037/31 entries

- [x] G7: Distinct behavioral mutations are caught and restored controls plus full affected suites/coverage, migration/erasure/architecture/RBAC/CI/static checks and zero new normalized AST findings pass
  CHECK: node .unlazy/verify-final.mjs
  EXPECT: members-final-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=70ed011a8764908675eead05322ef64eae686943552c5756b01805d69467f172; exit=0; EXPECT=matched; output-sha256=c516004127051d6228b2f253d2a93e29034030d47e87bf9461c28f43036fb053; output-bytes=1702; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-members-c121; path=2b1f1cc87037/31 entries
