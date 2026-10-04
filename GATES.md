# Gates: D16 optional hosted public form (C120)

OWNS: apps/orchestration-service/src/eval_run_visibility_http_server.ts, apps/eval-service/tests/test_orchestrator_integration.py, apps/platform-api/src/engine/engine-client.ts, apps/platform-api/src/engine/engine-client.spec.ts, apps/platform-api/src/engine/types.ts, scripts/check-architecture-boundaries.sh, docker-compose.yml, .env.local.example, infrastructure/ec2-mvp/**, apps/orchestration-service/src/runs/run-launcher.service.ts, apps/orchestration-service/src/run-launcher.module.ts, apps/background-workers/src/canonical-events/public-form-native-driver.ts, apps/platform-web/src/api/hosted-form-mock.spec.ts, packages/adapters/src/redis/public-form-receipt-store.ts, packages/adapters/src/redis/public-form-receipt-store.spec.ts, apps/orchestration-service/src/config/public-form-environment.ts, apps/orchestration-service/src/ingress.module.ts, apps/orchestration-service/src/database/migration-files.spec.ts, packages/auth/src/public-form-token.ts, packages/auth/src/public-form-token.spec.ts, packages/auth/src/index.ts, apps/public-surface/**, packages/contracts/src/public-forms.ts, packages/contracts/src/public-forms.spec.ts, packages/contracts/src/index.ts, packages/contracts/src/triggers.ts, packages/shared-clients/src/public-forms.ts, packages/shared-clients/src/index.ts, packages/adapters/src/cloudflare/**, packages/adapters/src/redis/public-form-rate-limiter.ts, packages/adapters/src/redis/public-form-rate-limiter.spec.ts, packages/adapters/src/index.ts, apps/orchestration-service/src/trigger-registry/**, apps/orchestration-service/drizzle/0053_public_forms.sql, apps/orchestration-service/drizzle/rollback/0053_drop_public_forms.sql, apps/orchestration-service/drizzle/meta/_journal.json, apps/platform-api/src/triggers/**, apps/platform-web/src/api/live.ts, apps/platform-web/src/api/client.ts, apps/platform-web/src/api/types.ts, apps/platform-web/src/api/live-triggers.spec.ts, apps/platform-web/src/features/triggers/components/**, docker/Dockerfile.node, docker/node-entrypoint.sh, docker/README.md, deploy/ec2/**, infrastructure/local/engine-db-init.sh, infrastructure/terraform/**, scripts/check-engine-db-runtime-roles.sh, scripts/check-engine-test-discovery.mjs, scripts/gates/baseline.json, pnpm-lock.yaml, docs/public-forms.md, docs/work-queue.md

Scope: D16's hosted form is an explicit option alongside a user's own source, never created automatically. Its separate Public Surface process serves `/f/<token>` and accepts only validated, Turnstile-verified, rate-limited fields through the existing trigger event pipeline. Disabled/replaced/foreign forms cannot submit. No uploads. Reuse the shared D15 classifier. Preserve ordinary tenant RLS and downstream run permissions/budgets.

- [x] G1: Authenticated authoring offers hosted form only by explicit choice, persists bounded form definitions on the trigger, returns its public link, and enforces role/current-version ownership when editing, disabling or replacing it
  CHECK: node .unlazy/verify-authoring.mjs
  EXPECT: public-form-authoring-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=a2fd4dc9c3cfec511bd44868da8f70d3d015e194cf2f1faa92ffe30af573f70f; exit=0; EXPECT=matched; output-sha256=7a3e0650a89418e2252e65fe0e89ed990adfc0612bbc9999c370c304eb13e52c; output-bytes=135; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-public-form-c120; path=2b1f1cc87037/31 entries

- [x] G2: A real separate HTTP process renders only current enabled form fields safely; opaque token validation and ordinary PostgreSQL scope refuse unknown, changed, disabled and foreign definitions without exposing other trigger settings
  CHECK: node .unlazy/verify-public.mjs
  EXPECT: public-form-public-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=0301da0b730d6a41b0e3c483984abe22731b8b0b3aac45cab26471ce46b7e396; exit=0; EXPECT=matched; output-sha256=2d87c4ee0932babdb1e5fcc7f95234e80042c361681ef169fce283b97e46f4c8; output-bytes=80; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-public-form-c120; path=2b1f1cc87037/31 entries

- [x] G3: Production Turnstile adapter verifies the submitted token and expected form context; failed/expired/repeated/invalid verification cannot dispatch, and missing configuration cannot become success
  CHECK: node .unlazy/verify-turnstile.mjs
  EXPECT: public-form-turnstile-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=1d45f50e01e80382c91e3b6b45557aea4d4df0338beded9ad7679aea8e6c7eb3; exit=0; EXPECT=matched; output-sha256=29b1f35839a3676da5073570069f6aedbc47fb341862522dc0e9313fa6fd443e; output-bytes=83; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-public-form-c120; path=2b1f1cc87037/31 entries

- [x] G4: Real atomic rate counters enforce independent form and visitor limits across concurrent requests before expensive work, malformed fields/uploads are refused, and the shared D15 classifier blocks classified injection or unavailable classification
  CHECK: node .unlazy/verify-input.mjs
  EXPECT: public-form-input-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=5762c1494768196e0d63741ed574273f0f92afd2a11a81769b1ca87588c0ad7a; exit=0; EXPECT=matched; output-sha256=3bd77f5237eeb07cdda0a0b4de5c44ba50bba7b8c08c1abaa8aba23c284edace; output-bytes=79; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-public-form-c120; path=2b1f1cc87037/31 entries

- [x] G5: A valid native form submission reaches the existing canonical trigger pipeline and creates an attributed event/run under ordinary PostgreSQL; retries do not duplicate runs and disabled/held workflows remain refused
  CHECK: node .unlazy/verify-dispatch.mjs
  EXPECT: public-form-dispatch-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=561626f4932cdf7de573ebd11538bcb234578bf71100674d92602250a42891b7; exit=0; EXPECT=matched; output-sha256=72957566d2b55f974eef12d512d7c5106f29a28a2bffc5958a16f6a58c67cfbf; output-bytes=82; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-public-form-c120; path=2b1f1cc87037/31 entries

- [x] G6: Live and mock setup controls preserve the own-source default, show/save hosted fields and public link only when selected, and surface failed/conflicting submissions without inventing success
  CHECK: node .unlazy/verify-web.mjs
  EXPECT: public-form-web-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=ba2d1fc48e2c87260e09d02de37ca56d02abd443d485777f81f6543417f18ecb; exit=0; EXPECT=matched; output-sha256=e2c77546c83c50d55d42f3843e0eb88ec0aa6d0056860de480a882073599cacc; output-bytes=77; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-public-form-c120; path=2b1f1cc87037/31 entries

- [x] G7: Distinct production mutations fail behavioral assertions and restored controls pass
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: public-form-controls-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=0168b52478281a9944b7970888c7b358f91a55f922d2e96861ff375b0a624cfb; exit=0; EXPECT=matched; output-sha256=3a06ac736f49ef191fe2c4297fe3be5e4d194bb98a049132de5c1c11b1590487; output-bytes=7060; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-public-form-c120; path=2b1f1cc87037/31 entries

- [x] G8: Full affected suites/coverage and static checks, separate production boot/routing and least-privilege bindings, paired migration/rollback, CI discovery, architecture/RBAC/naming and zero new normalized AST findings pass
  CHECK: node .unlazy/verify-final.mjs
  EXPECT: public-form-final-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=69210057c89fbc5ec518ba42dd20d5837d9f23835f1de7c4e57ef0127d9880f4; exit=0; EXPECT=matched; output-sha256=885d7390c45fc291f3f8d7090f44a0781037c1924caabfca536939209d43fe6c; output-bytes=1666; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-public-form-c120; path=2b1f1cc87037/31 entries

- [x] G9: Current workspace-scoped eval fixture proves own-run reads and foreign-run refusal through real controllers; full affected Eval suite, lint and type checks pass
  CHECK: node .unlazy/verify-eval.mjs
  EXPECT: public-form-eval-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=29c40c0d3e10d0e76ad0abb2b1683c026f26c3ea3c8874676829e6807df2d81c; exit=0; EXPECT=matched; output-sha256=a229c1b5ba6d29a300e889bf5b8f4815ad7c4cdf255bc512fc7b86b16c4bd033; output-bytes=106; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-public-form-c120; path=2b1f1cc87037/31 entries
