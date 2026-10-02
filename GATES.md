# Gates: D15 classifier parity and duplicate-safety enforcement (C106)

OWNS: packages/auth/session-gateway/src/prompt-injection-classifier.ts, packages/auth/session-gateway/src/prompt-injection-classifier.spec.ts, apps/verification-service/src/verification/model_gateway_client.py, apps/verification-service/tests/test_injection_parity.py, scripts/safety/injection-cases.json, scripts/safety/run-injection-cases.mjs, scripts/check-injection-parity.mjs, scripts/gates/safety-duplicate.mjs, scripts/gates/safety-duplicate-python.py, scripts/gates/safety-duplicate.spec.mjs, scripts/gates/probes/**, .github/workflows/ci.yml, docs/architecture/planes.md, docs/architecture/component-contracts.md, docs/work-queue.md, scripts/gates/baseline.json

Scope: Keep one classifier implementation per language. The real TypeScript and Python clients consume one case set through native loopback model gRPC, agree on classification and unavailable outcomes, and retain their existing caller-specific failure policies. CI invokes parity and actual duplicate-safety probes. A deterministic model edge tests contract behavior; paid model detection quality is not claimed.

- [x] G1: Both actual classifiers agree on every shared case over native model gRPC, preserve input and FAST routing, and use the same classification policy while preserving their existing unavailable handling
  CHECK: node .unlazy/verify-parity.mjs
  EXPECT: safety-parity-native-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=5c2dbeceab47d813093b28307decb2907f832d667486e44ee485281143320026; exit=0; EXPECT=matched; output-sha256=b21909a2c067490c81b0dfaefc24157a06b699a561a28fd70bf3ffe906e6d36e; output-bytes=149; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-safety-parity-c106; path=b33e9cf43ae9/31 entries

- [x] G2: The duplicate-safety gate permits ordinary transport and canonical consumers while identifying real duplicate implementation declarations, including renamed copies; the probe is invoked in CI
  CHECK: node .unlazy/verify-gate.mjs
  EXPECT: safety-duplicate-native-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=1de83880437595557ae07bbe560d7b6cec99d2d05c02216d6a588b405c925a52; exit=0; EXPECT=matched; output-sha256=b7943a7902742115f80ebee8b9093cf419c6da238fa4baca88899b4f1595bcad; output-bytes=62; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-safety-parity-c106; path=b33e9cf43ae9/31 entries

- [x] G3: Independently changed classifier verdicts and removed duplicate detection fail their corresponding native checks; restored sources pass
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: safety-parity-negative-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=ff14056998334330f0de73c6862b840cd3b65284ab96526e91d1eac233552a49; exit=0; EXPECT=matched; output-sha256=587aad9cf2e30c2e4d10b65710d382063a29c9b40ed6166f113fa4565c8090c5; output-bytes=646; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-safety-parity-c106; path=b33e9cf43ae9/31 entries

- [x] G4: Full auth, verification and adapter suites, affected static checks, architecture/RBAC, exact CI wiring and migration rollback pairing pass
  CHECK: node .unlazy/verify-full.mjs
  EXPECT: safety-parity-full-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=4436f905996a11f7a06216a88668bd867ff1a672248c3a63a10e05898d9284e8; exit=0; EXPECT=matched; output-sha256=3e762e185199189ff59d406e4b2ba15617d4f328efc20fa9e386cb823dccc1d9; output-bytes=426; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-safety-parity-c106; path=b33e9cf43ae9/31 entries

- [x] G5: The regenerated safety baseline is independently measured; all other normalized AST counts add zero entries and final architecture gates pass
  CHECK: node .unlazy/verify-baseline.mjs
  EXPECT: safety-parity-baseline-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=d832097c84afad1393ff7eaec1e18cd25767743153f309f4c4c6e3a7956e5c73; exit=0; EXPECT=matched; output-sha256=8e12d4e4cf3c51d3bca9d561b4f99d8edc6e6a4899b3544ea68f25ccf0fad677; output-bytes=114; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-safety-parity-c106; path=b33e9cf43ae9/31 entries
