# Gates: D19 runtime connection consumption (C108)

OWNS: apps/orchestration-service/src/connections/**, apps/orchestration-service/src/operations.module.ts, apps/orchestration-service/src/registry/handlers/toolcall*, apps/orchestration-service/src/recovery/failure-classifier.ts, apps/orchestration-service/src/recovery/failure-classifier.spec.ts, apps/tool-gateway/src/**, packages/contracts/src/connection-registry.ts, packages/contracts/src/index.ts, packages/contracts/proto/alter/toolgw/v1/toolgw.proto, packages/contracts/src/generated/alter/toolgw/v1/toolgw.ts, packages/adapters/src/grpc/toolgw*, packages/adapters/src/index.ts, packages/adapters/src/testing/toolgw-credential-client.ts, packages/adapters/src/testing/index.ts, packages/adapters/src/aws/secrets-manager-provider*, apps/eval-service/alter/toolgw/v1/**, scripts/gates/baseline.json, .env.local.example, deploy/ec2/**, docs/work-queue.md

OWNS: packages/adapters/src/postgres/tool-database-provider*

Scope: Tool Gateway resolves user connection credentials through current engine records scoped from the actual run. Both raw and opaque credential paths preserve that scope and refuse revoked, missing or unreadable credentials with the existing named credential-missing recovery category. Preserve existing platform credential templates and dispatch permissions. The compiler prerequisite is C100; I11 requires C99, C100 and C108.

- [ ] G1: Real restricted PostgreSQL and authenticated engine HTTP resolve only connected records in the actual run tenant/workspace, return references only, refuse mismatched scope and preserve the separate write credential
  CHECK: node .unlazy/verify-engine.mjs
  EXPECT: connection-runtime-engine-passed
  EVIDENCE: pending

- [ ] G2: Real Tool Gateway gRPC plus engine HTTP and native secret/provider edges exercise both credential entry points, opaque token reuse, current revocation and scope checks, unreadable credentials, successful dispatch and existing credential-missing recovery classification
  CHECK: node .unlazy/verify-runtime.mjs
  EXPECT: connection-runtime-native-passed
  EVIDENCE: pending

- [ ] G3: Production module wiring and local/EC2 configuration supply the actual read lookup address and service credential; additive wire changes retain legacy callers and existing platform credential templates
  CHECK: node .unlazy/verify-wiring.mjs
  EXPECT: connection-runtime-wiring-passed
  EVIDENCE: pending

- [ ] G4: Disabling scope/status, opaque revalidation, lookup authentication, database authentication classification or named gRPC error mapping fails the relevant native assertion; restored sources pass
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: connection-runtime-negative-passed
  EVIDENCE: pending

- [ ] G5: Full engine, Tool Gateway, adapters and contracts suites, build/typecheck/lint, proto compatibility, architecture, RBAC, rollback pairing and zero added normalized AST findings pass
  CHECK: node .unlazy/verify-final.mjs
  EXPECT: connection-runtime-final-passed
  EVIDENCE: pending
