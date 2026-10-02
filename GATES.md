# Gates: D19 connection compile preflight (C100)

OWNS: packages/contracts/src/index.ts, packages/contracts/src/connection-registry.ts, packages/contracts/src/workflow-dag.ts, apps/intelligence-service/src/selection_binding/**, apps/intelligence-service/tests/test_architecture_binding.py, apps/orchestration-service/src/compiler/**, apps/orchestration-service/src/connections/connection-preflight*, apps/orchestration-service/src/workflow-read/**, packages/adapters/src/index.ts, packages/adapters/src/grpc/compiler*, apps/platform-api/src/planner-facade/**, apps/platform-web/src/api/**, apps/platform-web/src/features/workflows/pages/workflow-create*, docs/work-queue.md, scripts/gates/baseline.json

Scope: Preserve explicit registered connector requirements and preflight every compile entry point against engine workspace records, returning one complete batch to the actual planner and web retry flow before any version is saved. Registry lifecycle is C99; runtime credential consumption remains the separately required next slice of I11.

- [x] G1: Real restricted PostgreSQL and native compiler transport exercise all three compile entry points, complete missing batches, connected references, tenant/workspace scope, revocation and zero inserted versions on gaps
  CHECK: node .unlazy/verify-native.mjs
  EXPECT: connection-preflight-native-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=8d0c0caf2994df74b3e0cf857e90f7cba311feaf2e669ec276b8a9c3d29bb501; exit=0; EXPECT=matched; output-sha256=6ac22f5d59e3babbcbc043b5deacc810ebf1896a7716cb8fa48253aded8110c1; output-bytes=411; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-connection-consumption-c100; path=b33e9cf43ae9/31 entries

- [x] G2: Registry binding preserves declared connector requirements and rejects invalid declarations; existing capability selection and intelligence checks pass
  CHECK: node .unlazy/verify-binding.mjs
  EXPECT: connection-preflight-binding-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=838f1394a5a1ed5a7f32e4c3071dbbb894530001e7ce61f5c62b107c8f08d42b; exit=0; EXPECT=matched; output-sha256=78924dcfaa1ace79b32caf8da432475470ae72b855fffade4f5458553aebbc22; output-bytes=36; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-connection-consumption-c100; path=b33e9cf43ae9/31 entries

- [x] G3: Native compiler response reaches the platform planner and live web flow as one complete batch; connect and retry preserve original goal, answers and workflow identity without reporting compilation early
  CHECK: node .unlazy/verify-flow.mjs
  EXPECT: connection-preflight-flow-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=fb68748269881880a75552b0b3beb63e837df198a0d8695f272e5b7ea2bc8c5f; exit=0; EXPECT=matched; output-sha256=27d35d9c1207999ee617a20af91922f3f5db8b25e3fbacfc3a2f24323db9aa82; output-bytes=784; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-connection-consumption-c100; path=b33e9cf43ae9/31 entries

- [x] G4: Disabling registry status/scope checks, batching, binding propagation or web handling causes the relevant native assertion to fail; restored sources pass
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: connection-preflight-negative-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=4db1de1b4efc93e0e4f2291b8ac3db78440bd32456d008a136fb6e4b9f615f1f; exit=0; EXPECT=matched; output-sha256=c3027cf358fcaa81fa46788d5b2c27703aec99088ede311fa70cc49f3a9497da; output-bytes=27682; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-connection-consumption-c100; path=b33e9cf43ae9/31 entries

- [x] G5: Full touched engine, adapters, platform coverage and web suites pass alongside additive contract compatibility
  CHECK: node .unlazy/verify-regression.mjs
  EXPECT: connection-preflight-regression-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=214dc5309b53de66037765d998d29e86c6e9fecc68017e27ee30a592b32222be; exit=0; EXPECT=matched; output-sha256=e2b6ade9f9b58e34ff62fdb8aa0cd80bb4c8f82f181bd69a8daf7610a8e2dac3; output-bytes=272596; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-connection-consumption-c100; path=b33e9cf43ae9/31 entries

- [x] G6: Build, typecheck, lint, actual CI registration, architecture, RBAC, rollback pairing and zero added normalized AST findings pass
  CHECK: node .unlazy/verify-final.mjs
  EXPECT: connection-preflight-final-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=031a6fd8ced1fbf542b559331ab95f68badc3d2b21b27425ea2e5eb60e636a5c; exit=0; EXPECT=matched; output-sha256=b8ffa15ce9fff0091e9ed7c3f5e435aa16c84eb11dd4820b135bcf5f2c21aa83; output-bytes=34; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-connection-consumption-c100; path=b33e9cf43ae9/31 entries
