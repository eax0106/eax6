# Gates: D19 runtime connection consumption (C108)

OWNS: apps/orchestration-service/src/health/health.controller.spec.ts, apps/orchestration-service/src/connections/**, apps/orchestration-service/src/operations.module.ts, apps/orchestration-service/src/registry/handlers/toolcall*, apps/orchestration-service/src/recovery/failure-classifier.ts, apps/orchestration-service/src/recovery/failure-classifier.spec.ts, apps/tool-gateway/src/**, packages/contracts/src/connection-registry.ts, packages/contracts/src/index.ts, packages/contracts/proto/alter/toolgw/v1/toolgw.proto, packages/contracts/src/generated/alter/toolgw/v1/toolgw.ts, packages/adapters/src/grpc/toolgw*, packages/adapters/src/index.ts, packages/adapters/src/testing/toolgw-credential-client.ts, packages/adapters/src/testing/index.ts, packages/adapters/src/aws/secrets-manager-provider*, apps/eval-service/alter/toolgw/v1/**, apps/eval-service/tests/test_orchestrator_integration.py, scripts/gates/baseline.json, .env.local.example, deploy/ec2/**, docs/work-queue.md

OWNS: packages/adapters/src/postgres/tool-database-provider*

Scope: Tool Gateway resolves user connection credentials through current engine records scoped from the actual run. Both raw and opaque credential paths preserve that scope and refuse revoked, missing or unreadable credentials with the existing named credential-missing recovery category. Preserve existing platform credential templates and dispatch permissions. The compiler prerequisite is C100; I11 requires C99, C100 and C108.

- [x] G1: Real restricted PostgreSQL and authenticated engine HTTP resolve only connected records in the actual run tenant/workspace, return references only, refuse mismatched scope and preserve the separate write credential
  CHECK: node .unlazy/verify-engine.mjs
  EXPECT: connection-runtime-engine-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=a99c14bce457a9f06ba0b432727fe546c7b035c34ebfdf310729f1e7fb664045; exit=0; EXPECT=matched; output-sha256=9a6f5ac00f3d48f9a9c6a61fdb35bc8c397eb42e58684d7887dc56899816b496; output-bytes=97; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-connection-runtime-c108; path=b33e9cf43ae9/31 entries

- [x] G2: Real Tool Gateway gRPC plus engine HTTP and native secret/provider edges exercise both credential entry points, opaque token reuse, current revocation and scope checks, unreadable credentials, successful dispatch and existing credential-missing recovery classification
  CHECK: node .unlazy/verify-runtime.mjs
  EXPECT: connection-runtime-native-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=80f94f346b22dbc114e122b14c09843cbc970aa7be74b4a471dbe1b30f78aeae; exit=0; EXPECT=matched; output-sha256=932ab675e5cbafb967dc084da4c9d04a9f2a84c05d1c6a255fb5756a1c426443; output-bytes=151; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-connection-runtime-c108; path=b33e9cf43ae9/31 entries

- [x] G3: Production module wiring and local/EC2 configuration supply the actual read lookup address and service credential; additive wire changes retain legacy callers and existing platform credential templates
  CHECK: node .unlazy/verify-wiring.mjs
  EXPECT: connection-runtime-wiring-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=ff1611c0484aebc0734d121351cfeaa10392a0f5dac0159b38da2a3e01afbd74; exit=0; EXPECT=matched; output-sha256=a1c6c860c5db94b0506f3d91e2440824c6cd4ab1dc22894868e8cc557302c4db; output-bytes=198; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-connection-runtime-c108; path=b33e9cf43ae9/31 entries

- [x] G4: Disabling scope/status, opaque revalidation, lookup authentication, database authentication classification or named gRPC error mapping fails the relevant native assertion; restored sources pass
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: connection-runtime-negative-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=fe5a4caaacee45555500fb75be1c9a3d60765cdc11b93b779e9942a6ae670305; exit=0; EXPECT=matched; output-sha256=23e1825e12ba0b7cca9f3a7ecff12a93bf8216383032ec05533199c5c55f9b80; output-bytes=6231; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-connection-runtime-c108; path=b33e9cf43ae9/31 entries

- [ ] G5: Full engine, Tool Gateway, adapters and contracts suites, build/typecheck/lint, proto compatibility, architecture, RBAC, rollback pairing and zero added normalized AST findings pass
  CHECK: node .unlazy/verify-final.mjs
  EXPECT: connection-runtime-final-passed
  EVIDENCE: pending
