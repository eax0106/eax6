# Gates: D7 workspace invitations and fixed roles (C121)

OWNS: tests/integration/rbac/workspace-invitations.spec.ts, apps/platform-api/src/members/**, apps/platform-api/src/identity/**, apps/platform-api/src/signup/**, apps/platform-api/src/config/env.schema.ts, apps/platform-api/src/config/env.schema.spec.ts, apps/platform-api/src/db/migrations/0033_workspace_invitations.sql, apps/platform-api/src/db/migrations/rollback/0033_drop_workspace_invitations.sql, apps/platform-api/src/db/migrations/meta/_journal.json, apps/platform-api/src/db/schema/**, apps/platform-api/src/db/db.migration.spec.ts, apps/platform-api/src/db/platform-db-schema-completeness.spec.ts, apps/platform-api/project.json, apps/platform-api/src/deletion/**, apps/platform-api/src/workspaces/**, packages/deletion-registry/src/**, apps/platform-web/src/api/**, apps/platform-web/src/features/members/**, apps/platform-web/src/features/settings/pages/security-settings.tsx, apps/platform-web/src/features/settings/pages/security-settings.spec.tsx, apps/platform-web/src/features/auth/**, apps/platform-web/src/layout/workspace-switcher.tsx, apps/platform-web/src/features/permissions/**, apps/platform-web/src/features/roles/**, docs/members.md, docs/work-queue.md, scripts/gates/baseline.json, deploy/ec2/**, .env.local.example

Scope: D7 hybrid invites use Alter's tenant-scoped invitation record as authority and Auth0 organization invitations for delivery. Verified callback accepts a current unexpired invitation into its selected workspace and fixed role. Resend/revoke protect races. Existing five enforced workspace roles and tenant owner badge appear in live/mock UI; role changes are audited and cannot alter owner or demote/remove last admin. Password reset remains with selected identity provider. No custom roles or third-party message outside explicit invitation/reset action.

- [ ] G1: Ordinary PostgreSQL enforces invitation tenant/workspace scope, seven-day expiry, uniqueness and erasure; paired migration and rollback preserve other memberships
  CHECK: node .unlazy/verify-store.mjs
  EXPECT: members-store-passed
  EVIDENCE: pending

- [ ] G2: Auth0 organization invitation creation/cancellation and password-reset requests use documented provider APIs; mock mirrors lifecycle and unavailable/invalid provider responses never report sent
  CHECK: node .unlazy/verify-provider.mjs
  EXPECT: members-provider-passed
  EVIDENCE: pending

- [ ] G3: Authenticated routes create/list/resend/revoke invitations only in managed workspaces; concurrent operations and failed delivery leave truthful statuses and attributed audit records
  CHECK: node .unlazy/verify-invitations.mjs
  EXPECT: members-invitations-passed
  EVIDENCE: pending

- [ ] G4: Real callback accepts only verified matching identity into a current pending invitation, creates correct tenant/workspace membership once, and refuses revoked/expired/foreign invitations before issuing access
  CHECK: node .unlazy/verify-callback.mjs
  EXPECT: members-callback-passed
  EVIDENCE: pending

- [ ] G5: Workspace role updates/removal enforce five fixed roles, caller workspace admin rights, immutable tenant owner and last-admin protection under concurrency; audit and immediate access revocation persist
  CHECK: node .unlazy/verify-roles.mjs
  EXPECT: members-roles-passed
  EVIDENCE: pending

- [ ] G6: Live/mock/rendered UI uses actual workspace, displays current members/pending invites and owner badge, supports five roles/resend/revoke/role changes/password reset, and keeps errors visible without fabricated success
  CHECK: node .unlazy/verify-web.mjs
  EXPECT: members-web-passed
  EVIDENCE: pending

- [ ] G7: Distinct behavioral mutations are caught and restored controls plus full affected suites/coverage, migration/erasure/architecture/RBAC/CI/static checks and zero new normalized AST findings pass
  CHECK: node .unlazy/verify-final.mjs
  EXPECT: members-final-passed
  EVIDENCE: pending
