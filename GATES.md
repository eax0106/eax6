# Gates: recursive engine test discovery (C111)

OWNS: apps/orchestration-service/project.json, scripts/check-engine-test-discovery.mjs, docs/work-queue.md

Scope: The actual Nx engine test command must reach every tracked engine spec, including nested handlers. Keep a runnable actual-Vitest discovery check in that same CI task. Preserve the test assertions, application behavior and live-only skip conditions. No migration or dependency change.

- [x] G1: Actual Vitest discovery from the configured test command exactly covers all tracked engine spec files, including nested handlers, and the discovery driver runs before the CI test task
  CHECK: node .unlazy/verify-discovery.mjs
  EXPECT: engine-test-discovery-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=37feedec9ab05e2968f9cd5ede4438507101288151abeadddab5dbd38d38ce7a; exit=0; EXPECT=matched; output-sha256=40dc12df5e5482d38fa355f616f3a50c8932cd46ea38079ed0fc6870602a1137; output-bytes=30; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-engine-test-discovery-c111; path=b33e9cf43ae9/31 entries

- [x] G2: Restoring the original shell-expanded test command makes the actual discovery check fail for omitted tracked specs; the restored command passes
  CHECK: node .unlazy/negative-control.mjs
  EXPECT: engine-test-discovery-negative-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=151bd312c3f8ce3c0718a8299a1bfc7a59152886b4e34cd7a2a3829057a9c342; exit=0; EXPECT=matched; output-sha256=b850f0a3b7d8592e14d0bd280d4c2bdfa9c95d217d662cadc2134602855bbb72; output-bytes=94; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-engine-test-discovery-c111; path=b33e9cf43ae9/31 entries

- [x] G3: The configured Nx task runs the complete recursive engine suite; syntax, build/typecheck/lint, architecture, RBAC, naming, rollback pairing and unchanged normalized AST findings pass
  CHECK: node .unlazy/verify-regression.mjs
  EXPECT: engine-test-discovery-regression-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=dcbf01fb8020ca0952e52fc96ec2963e6921bcd0ee69d3767e787f35e6f04a34; exit=0; EXPECT=matched; output-sha256=658ed05e92c53f6a9124f5121e65d63b95952958423184aa464750981f6c275b; output-bytes=427; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-engine-test-discovery-c111; path=b33e9cf43ae9/31 entries
