# Gates: D12 memory switches and retention (C114)

OWNS: apps/model-gateway/src/gateway/memory-redaction-native.integration.spec.ts, apps/memory-service/**, apps/ads-core/src/config.py, apps/ads-core/src/ingestion/router.py, apps/ads-core/src/ingestion/embedding_client.py, apps/ads-core/src/memory_namespace/**, apps/ads-core/src/query/**, apps/ads-core/src/deletion/**, apps/ads-core/scripts/generate_protos.py, apps/ads-core/alter/memory/**, apps/ads-core/tests/test_memory_settings_integration.py, apps/ads-core/tests/test_memory_namespace.py, apps/platform-api/src/memory-settings/**, apps/platform-api/src/app.module.ts, apps/platform-api/src/workflow-chat/**, apps/platform-web/src/api/client.ts, apps/platform-web/src/api/types.ts, apps/platform-web/src/api/mock/data.ts, apps/platform-web/src/api/live-memory-settings.ts, apps/platform-web/src/api/live-memory-settings.spec.ts, apps/platform-web/src/features/knowledge/pages/memory-settings.tsx, apps/platform-web/src/features/knowledge/pages/memory-settings.spec.tsx, packages/contracts/proto/alter/memory/v1/memory.proto, packages/contracts/src/memory-settings.ts, packages/contracts/src/memory-settings.spec.ts, packages/contracts/src/index.ts, packages/adapters/src/grpc/memory-client.ts, packages/adapters/src/grpc/memory-client.spec.ts, packages/deletion-registry/src/declaration.ts, apps/orchestration-service/src/registry/run-finalization-memory-writer.ts, apps/orchestration-service/src/registry/run-finalization-memory-writer.spec.ts, apps/orchestration-service/src/registry/handlers/memory-write.handler.ts, apps/orchestration-service/src/registry/handlers/memory-write.handler.spec.ts, scripts/gates/baseline.json, docs/work-queue.md

Scope: D12 implements per-workspace chat, workflow and workspace memory switches, on by default, and a 7–365 day retention window defaulting to 90. Memory-service checks each kind before storing or recalling it; actual workflow chat and ADS consumers honor the result. Store memories with PII redacted, remove allow-sensitive-data, and preserve the separate anonymised cross-tenant policy layer. Settings writes require If-Match and commit their audit in the same locked transaction. Erasure, rollback and scheduled retention remain real.

- [ ] G1: Restricted PostgreSQL and authenticated memory settings transport prove workspace defaults, strict values, If-Match missing/stale/concurrent writes, atomic audit rollback, tenant/workspace separation, erasure and reversible migration
  CHECK: node .unlazy/verify-settings.mjs
  EXPECT: memory-settings-native-passed
  EVIDENCE: pending

- [ ] G2: Real memory-service storage and recall enforce independent chat/workflow switches and retention; actual caller-authenticated redaction output is stored and recalled, while separate global policy operations keep their existing behavior
  CHECK: node .unlazy/verify-recall.mjs
  EXPECT: memory-recall-native-passed
  EVIDENCE: pending

- [ ] G3: Actual ADS writes/reads call memory-service for workspace settings, respect validated scopes and retention, and actual scheduled sweeps delete expired local memories without deleting current or other-workspace records
  CHECK: node .unlazy/verify-ads-retention.mjs
  EXPECT: memory-ads-retention-passed
  EVIDENCE: pending

- [ ] G4: Public API RBAC and actual live web requests preserve ETag/If-Match, show validation/conflict/error recovery, expose three correctly labelled switches and retention only, and actual workflow builder uses the memory-service recall result
  CHECK: node .unlazy/verify-delivery.mjs
  EXPECT: memory-settings-delivery-passed
  EVIDENCE: pending

- [ ] G5: Each consequential switch, scope, retention, audit, PII or live-route assertion has a known-positive control that fails when the corresponding production check is removed and passes after restoration
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: memory-settings-controls-passed
  EVIDENCE: pending

- [ ] G6: Full touched Python and TypeScript suites, native transport discovery, build/typecheck/lint, proto consistency, migration/erasure registration, architecture/RBAC/naming and zero added normalized AST findings pass
  CHECK: node .unlazy/verify-final.mjs
  EXPECT: memory-settings-final-passed
  EVIDENCE: pending
