# Gates: D25 staff golden-set history (C124)

OWNS: apps/eval-service/src/db/session.py, apps/eval-service/src/grpc_server.py, apps/eval-service/src/history/**, apps/eval-service/src/main.py, apps/eval-service/tests/test_history.py, apps/platform-api/src/benchmarks/**, apps/platform-web/src/api/services/benchmark-history.ts, apps/platform-web/src/api/services/benchmark-history.spec.ts, apps/platform-web/src/features/admin/pages/platform/benchmark-history.tsx, apps/platform-web/src/features/admin/pages/platform/benchmark-history.spec.tsx, apps/platform-web/src/features/admin/layout/admin-sidebar.tsx, apps/platform-web/src/app/router.tsx, deploy/ec2/**, .env.local.example, docs/work-queue.md, scripts/gates/baseline.json

Scope: Staff golden-set run history backed by actual eval-service PostgreSQL records and current staff authorization. D25 tenant datasets, per-case Simulate execution and customer Benchmarks remain independently required in the root roadmap. No live model call or cloud apply is required for this leaf.

- [x] G1: Authenticated eval-service HTTP lists actual golden-set runs with scores and stable bounded pagination through ordinary forced RLS; no missing service credential or invalid filter reaches storage
  CHECK: node .unlazy/verify-history.mjs
  EXPECT: benchmark-history-storage-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=ac2c8bf8de996a54f3ffa325f07234a69f9ff44240d29063239b6de717733b4e; exit=0; EXPECT=matched; output-sha256=292a6d4c141821b72f6441b5c2a002ec538d1f41db0705c951ee19f81f5b215b; output-bytes=36; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-benchmarks-c124; path=2b1f1cc87037/31 entries

- [x] G2: Platform history routes authorize current staff roles only and preserve pagination and upstream failure semantics; nonstaff and expired sessions cannot read history
  CHECK: node .unlazy/verify-http.mjs
  EXPECT: benchmark-history-http-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=a2cfa3facf10d6191bcc21a4da4866887a530bf2239867c65cc6f4ec56dd0027; exit=0; EXPECT=matched; output-sha256=717f80cc5b9b746df33f4cb77fef7ff8b23ba78087fe3e54011c57fdc23f8eab; output-bytes=84; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-benchmarks-c124; path=2b1f1cc87037/31 entries

- [x] G3: Admin history page displays actual golden set, version, status, pass rate and timestamps; loading, empty, unavailable and subsequent pages remain honest
  CHECK: node .unlazy/verify-web.mjs
  EXPECT: benchmark-history-web-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=85687a7a0abdd5f8f0a59f9c550ad5783175c05bd9135a8b3aa681463ecc2ba0; exit=0; EXPECT=matched; output-sha256=6018a75ebb4b67990594a8ebbb4947ec34e9924a40c0246e94526fee993153a3; output-bytes=81; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-benchmarks-c124; path=2b1f1cc87037/31 entries

- [x] G4: Production configuration routes the authenticated history client to the eval-service listener and preserves existing evaluation run/release gate behavior
  CHECK: node .unlazy/verify-production.mjs
  EXPECT: benchmark-history-production-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=c85e39e07a88a2f4f89c984b76957337788adf57c7d6554958cf48bb4d0e4331; exit=0; EXPECT=matched; output-sha256=fba9209ec9f7ed104da9f198fc87f14c1d17a1bd87918603e2286562ce12fade; output-bytes=202; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-benchmarks-c124; path=2b1f1cc87037/31 entries

- [x] G5: Decisive fault controls fail and restored code passes; full affected tests, static checks, real transport, architecture/RBAC and normalized AST checks pass
  CHECK: node .unlazy/verify-final.mjs
  EXPECT: benchmark-history-final-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=2ba56d042eeb04b629cc60fdd621293aeda1715937e28bfb999cd2fd63bbd323; exit=0; EXPECT=matched; output-sha256=eb16d8b58baa50b3c642033c02c869e3439f4d29921ccda847cd9b876f4154be; output-bytes=889; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-benchmarks-c124; path=2b1f1cc87037/31 entries
