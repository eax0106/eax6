# Gates: Billing runtime database wiring (C134)

OWNS: deploy/ec2/platform-db-roles.sql, deploy/ec2/check-platform-db-roles.sh, apps/platform-api/src/billing/config.ts, apps/platform-api/src/billing/billing.module.ts, apps/platform-api/src/billing/billing.module.spec.ts, apps/platform-api/src/billing/billing-policy.module.ts, apps/platform-api/src/billing/billing-policy.service.ts, apps/platform-api/src/deletion/config.ts, apps/platform-api/src/deletion/platform-deletion.module.ts, apps/platform-api/src/deletion/platform-deletion.service.ts, apps/platform-api/src/deletion/platform-deletion.module.spec.ts, apps/platform-api/src/billing/billing-runtime.native.spec.ts, docs/work-queue.md, scripts/gates/baseline.json

Scope: Existing merged billing routes, delivery reconciliation and erasure must execute under the actual EC2 tenant/staff runtime identities after the role kit is reapplied. Staff billing inventory and system delivery inventory use the configured operations connection. Manifest-guarded erasure keeps ordinary scoped transactions; orphan-user finalization uses the existing operations identity only after scoped deletion. Existing unguarded administration helpers stay unavailable to tenant connections. Ordinary scoped mutations retain FORCE RLS, current staff checks, exact revisions and audit acknowledgement. Add only named required helper grants, preserving existing role boundaries, public revocations and dedicated retention. No live payment or deployed database mutation.

- [x] G1: Native PostgreSQL with the actual role kit before migrations and twice afterward proves required billing inventory, delivery and manifest-scoped erasure functions callable through their intended runtime identity, and current runtime roles retain existing isolation and DDL restrictions
  CHECK: node .unlazy/verify-runtime-storage.mjs
  EXPECT: billing-runtime-storage-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=237e847b0e124be607455a2d3c105128f03dada1c11d6a8b7e3c193a67de4ac0; exit=0; EXPECT=matched; output-sha256=ec39c6ce4f5067c270ebd40cd89430171c697e7e584fc409b20e3f8d73ca0c04; output-bytes=95; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-billing-runtime-c134; path=2b1f1cc87037/31 entries

- [x] G2: Actual production BillingModule uses the configured staff connection only for staff inventory while scoped settings, history and credit delivery keep the ordinary tenant connection; missing configuration and inherited environment behavior remain explicit
  CHECK: node .unlazy/verify-runtime-wiring.mjs
  EXPECT: billing-runtime-wiring-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=4dba1e452d6902afef41a38bd739a36185ca373085dc5130971192671ac62965; exit=0; EXPECT=matched; output-sha256=3a2bae58227b8b590e292b69a52b69adce801e07e90b1bb4becfffa9a6d05dc2; output-bytes=146; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-billing-runtime-c134; path=2b1f1cc87037/31 entries

- [x] G3: Original missing grants and wrong runtime connection fail decisive behavioral checks and restored code passes; native role reapply, full affected API coverage and static/build, deployment shell syntax, architecture/RBAC/migration checks and zero added normalized AST findings pass
  CHECK: node .unlazy/verify-runtime-final.mjs
  EXPECT: billing-runtime-final-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=6a6bb58dcb8f8abea3b8772ccda4ea2b089a288fd2ea82fe3a658e2a158ec885; exit=0; EXPECT=matched; output-sha256=d67202e2070942e66b4b6be2af22b30801be91d8e4cf6918ad1ee60ce5a09df8; output-bytes=861; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-billing-runtime-c134; path=2b1f1cc87037/31 entries
