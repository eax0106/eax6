# Gates: non-local static database auth (Neon)

Acceptance for replacing AWS RDS IAM authentication with static (password)
authentication outside local environments, so the engine services can reach
Neon. Written before the change; every gate starts unmet.

Probed on Neon PG 18.6 (Singapore) before this work: pgcrypto, vector, pg_trgm
and btree_gist all install; a role can be created with BYPASSRLS; a SQL-created
login role has no neon_superuser membership and RLS filters its reads
correctly. `neondb_owner` holds BYPASSRLS, so services must never connect as it.

- [x] G1: audit, cost-ledger and orchestration select static auth outside local
  CHECK: node scripts/gates/run-tests.mjs apps/audit-service/src/config/environment.spec.ts apps/cost-ledger-service/src/config/environment.spec.ts apps/orchestration-service/src/orchestration-infrastructure.module.spec.ts
  EXPECT: gate-tests-ok
  EVIDENCE: automatic-evidence=v1; definition-sha256=bde0c5cd58906d45babdbe9ff7162723611ef9b83602ad10ace1f6996e7f9692; exit=0; EXPECT=matched; output-sha256=77d6504507f0bd3cb379fe4fd0bcc96c1af775dc39214891bc469c67f2a473cc; output-bytes=327; shell=C:\Program Files\Git\bin\bash.exe; cwd=C:\Users\rajen\alter-work\alter-x-4-neon; path=967b5d64bfe8/45 entries

- [x] G2: a static store refuses a connection string that does not require TLS
  CHECK: node scripts/gates/run-tests.mjs packages/adapters/src/postgres/orchestration-store-provider.unit.spec.ts packages/adapters/src/postgres/audit-store-provider.unit.spec.ts packages/adapters/src/postgres/cost-store-provider.unit.spec.ts
  EXPECT: gate-tests-ok
  EVIDENCE: automatic-evidence=v1; definition-sha256=a84ab59e327e834bc7ab68e1d7826fc842c7f7bd427f506a1cfc9e5269d313e5; exit=0; EXPECT=matched; output-sha256=25f5f7e935094cce1c8d3f1010d8a3a112af70f9a35e98c5417e0af54c86ce35; output-bytes=319; shell=C:\Program Files\Git\bin\bash.exe; cwd=C:\Users\rajen\alter-work\alter-x-4-neon; path=967b5d64bfe8/45 entries

- [x] G3: tenant isolation still denies cross-tenant reads on a real database
  CHECK: node scripts/gates/run-tests.mjs packages/adapters/src/postgres/conversation-goal-state-rls.spec.ts
  EXPECT: gate-tests-ok
  EVIDENCE: automatic-evidence=v1; definition-sha256=359e5967a33f893a2d0c8f8af512440933c070736a4ef3da78ba5af18eae1d37; exit=0; EXPECT=matched; output-sha256=753b3dde833aea4a2553812f53d0a25b5a09249145608539d4b3176291ff4d03; output-bytes=257; shell=C:\Program Files\Git\bin\bash.exe; cwd=C:\Users\rajen\alter-work\alter-x-4-neon; path=967b5d64bfe8/45 entries

- [x] G4: engine app code still imports no @temporalio/* directly
  CHECK: bash scripts/check-architecture-boundaries.sh
  EXPECT: architecture-boundary ok
  EVIDENCE: automatic-evidence=v1; definition-sha256=ccdde8534f82a45f2d681192fb8012332e4caca4a7a737e3d6e1164a10a53aca; exit=0; EXPECT=matched; output-sha256=6933b5b6fd623ffe57781f67353f14454bc125902dd4ef71c3d41daa4669364a; output-bytes=25; shell=C:\Program Files\Git\bin\bash.exe; cwd=C:\Users\rajen\alter-work\alter-x-4-neon; path=967b5d64bfe8/45 entries

- [x] G5: the pull request is reviewing the commit checked out here
  CHECK: node scripts/verify-pr-head.mjs head feat/neon-static-db-auth
  EXPECT: pr-head-matches
  EVIDENCE: automatic-evidence=v1; definition-sha256=4237cfa46805337452210303cf13ec5b93318ece394384ac7b9e1c8162cf7857; exit=0; EXPECT=matched; output-sha256=c210627735b3af5f48fac1da4190987fb8f3d48888624fdfbca4480471a2e42f; output-bytes=24; shell=C:\Program Files\Git\bin\bash.exe; cwd=C:\Users\rajen\alter-work\alter-x-4-neon; path=967b5d64bfe8/45 entries

- [x] G6: CI succeeded for that exact commit
  CHECK: node scripts/verify-pr-head.mjs ci feat/neon-static-db-auth
  EXPECT: ci-success-for-head
  EVIDENCE: automatic-evidence=v1; definition-sha256=4ea0ff6dac41be13aa42a6172eafad2ea1bd5e9e0d076c059f3152583d6b8646; exit=0; EXPECT=matched; output-sha256=ab87bced6970625e0201f28b1b2ee479a1aed2c9a8c5d3c36e9e45b8625834a7; output-bytes=35; shell=C:\Program Files\Git\bin\bash.exe; cwd=C:\Users\rajen\alter-work\alter-x-4-neon; path=967b5d64bfe8/45 entries

- [x] G7: tenant isolation also holds on the Postgres major version Neon runs
  CHECK: node scripts/gates/run-tests.mjs --image postgres:18-alpine packages/adapters/src/postgres/conversation-goal-state-rls.spec.ts
  EXPECT: gate-tests-ok
  EVIDENCE: automatic-evidence=v1; definition-sha256=e69983bb60faa57c9ffe4eb0ceaa8ea8c8cfcd6a05e28320923bb90110dd07e2; exit=0; EXPECT=matched; output-sha256=2996f566c09854cec72ff5b954bfbc84dce96e937825e89eb6490e63353a990d; output-bytes=255; shell=C:\Program Files\Git\bin\bash.exe; cwd=C:\Users\rajen\alter-work\alter-x-4-neon; path=967b5d64bfe8/45 entries
