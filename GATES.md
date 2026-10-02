# Gates: full-process finalize retry proof (C101)

OWNS: apps/orchestration-service/src/registry/finalize-replay.integration.spec.ts, docs/work-queue.md, scripts/gates/baseline.json

Scope: Exercise the production Temporal workflow and activities through a separately booted engine and Python verification service, dropping the first successful finalize response. The model edge is a local contract fixture; this proves retry behavior, not model quality or paid-provider readiness. The regression runs in the existing engine test target.

- [x] G1: A real Temporal activity retry through the actual engine and verification processes preserves one acceptance row, one classification and one pair of reviewer calls over the actual terminal output
  CHECK: node .unlazy/verify-behavior.mjs
  EXPECT: finalize-replay-behavior-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=1904bea19d397046c6a3d00125ced9ef73b1a4e5acad3777a3f531d7dd913e49; exit=0; EXPECT=matched; output-sha256=37cf90d61b2ecf41cb9af2f96dfa405530a9df938ec40cfa7c89d2319369aac4; output-bytes=162; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-finalize-replay-c101; path=b33e9cf43ae9/31 entries

- [x] G2: Removing the existing terminal and recorded-verdict guards fails the retry assertions, and restored sources pass through the same full-process check
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: finalize-replay-negative-control-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=a9cbb3951d834ed0e8a3482b5ce5e94e8bfe97d959161b99df0173b24d049f25; exit=0; EXPECT=matched; output-sha256=28d39290f12f3c981387e21c10dab46a419d69a465d130c06a2906249b140f71; output-bytes=392; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-finalize-replay-c101; path=b33e9cf43ae9/31 entries

- [x] G3: Engine build, typecheck, lint, existing acceptance regressions, architecture and zero added AST findings pass; the normal engine test target includes the new regression
  CHECK: node .unlazy/verify-static.mjs
  EXPECT: finalize-replay-static-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=791d2290f23cd3308bdb220d9eaf93c8a7e9059849e3462ffa7e88196ab370e0; exit=0; EXPECT=matched; output-sha256=7fc2866b2650bf97cc0aa8b6557fec80e0f584765b6e81feab724e7e817a56e0; output-bytes=221; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-finalize-replay-c101; path=b33e9cf43ae9/31 entries
