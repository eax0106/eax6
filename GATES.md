# Gates: internal performance service operations (C105)

OWNS: apps/intelligence-service/src/performance/router.py, apps/intelligence-service/src/performance/repository.py, apps/intelligence-service/src/performance/audit.py, apps/intelligence-service/src/config.py, apps/intelligence-service/src/main.py, apps/intelligence-service/alembic/versions/0009_agent_owner_tenant.py, apps/intelligence-service/tests/test_performance_router.py, apps/intelligence-service/tests/test_migrations.py, apps/intelligence-service/tests/test_deletion.py, apps/memory-service/src/config.py, apps/memory-service/src/drift/router.py, apps/memory-service/src/drift/intelligence_client.py, apps/memory-service/tests/test_drift_integration.py, apps/audit-service/src/audit/performance.fixture.spec.ts, docs/work-queue.md, scripts/gates/baseline.json

Scope: Apply the established shared service credential to internal performance operations. Check an asserted tenant against the addressed agent, distinguish refusal from absence, and record every validated assertion through the existing audit HTTP service. Keep ordinary RLS and composite foreign keys. Align the memory performance caller with this established credential. Root SC requires both C104 and C105.

- [x] G1: Fresh PostgreSQL migrations provision the service role without elevated privileges, preserve an existing runtime role, and the real restricted database and guarded HTTP/audit service exercise valid operations, refusals, absent resources and persisted audit results
  CHECK: node .unlazy/verify-native.mjs
  EXPECT: performance-service-native-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=a181c4db12e0520e97e84f1d3fd90cc72185872fb60afbe68e71d7f6753ffc21; exit=0; EXPECT=matched; output-sha256=4e3b6a122b0dd4ca71e1f5780f4ae47d2941349b91cb415d2480da0c8dbd4757; output-bytes=65; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-performance-scope-c105; path=b33e9cf43ae9/31 entries

- [x] G2: Removing role provisioning, credential validation, ownership comparison or audit recording fails its corresponding native check; restored sources pass
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: performance-service-negative-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=1b09e6f58609cc83a5248991dc0a716f81a2e31a3b6bc8c54ef68e14a9c6f896; exit=0; EXPECT=matched; output-sha256=3906b97885a90edcecb64418c722cfd930dc8fd76ff89d5a5488b16e09a115be; output-bytes=3072; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-performance-scope-c105; path=b33e9cf43ae9/31 entries

- [x] G3: The real memory/intelligence HTTP drift path uses the configured shared credential, retains workspace/tenant RLS, and passes its existing regression suite
  CHECK: node .unlazy/verify-memory.mjs
  EXPECT: performance-service-memory-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=6b7d0911aa536c019c7d20f440bdfa42e22eed5dc23948357cc1f3b98f7c6d8c; exit=0; EXPECT=matched; output-sha256=102f44de0fda1e1ef8ca416bf4cd8dd6a467d54fe189ee6d77f466c81fd1a973; output-bytes=53; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-performance-scope-c105; path=b33e9cf43ae9/31 entries

- [x] G4: Full intelligence, memory and audit suites, Python lint/typechecks/proto checks, audit static checks, migration rollback, architecture, RBAC and zero added AST findings pass
  CHECK: node .unlazy/verify-full.mjs
  EXPECT: performance-service-full-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=a5a80cdf4b12a18d76f312762c4d629fb0230cab086948dc91508e04f8fb88b7; exit=0; EXPECT=matched; output-sha256=f489e1ccdadceab2720c298b7b4c8f8af54a5a16fc55718ee5fae66b222521a6; output-bytes=573; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-performance-scope-c105; path=b33e9cf43ae9/31 entries
