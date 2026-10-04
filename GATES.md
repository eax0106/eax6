# Gates: D16 optional hosted public form (C120)

OWNS: packages/adapters/src/redis/public-form-receipt-store.ts, packages/adapters/src/redis/public-form-receipt-store.spec.ts, apps/orchestration-service/src/config/public-form-environment.ts, apps/orchestration-service/src/ingress.module.ts, apps/orchestration-service/src/database/migration-files.spec.ts, packages/auth/src/public-form-token.ts, packages/auth/src/public-form-token.spec.ts, packages/auth/src/index.ts, apps/public-surface/**, packages/contracts/src/public-forms.ts, packages/contracts/src/public-forms.spec.ts, packages/contracts/src/index.ts, packages/contracts/src/triggers.ts, packages/shared-clients/src/public-forms.ts, packages/shared-clients/src/index.ts, packages/adapters/src/cloudflare/**, packages/adapters/src/redis/public-form-rate-limiter.ts, packages/adapters/src/redis/public-form-rate-limiter.spec.ts, packages/adapters/src/index.ts, apps/orchestration-service/src/trigger-registry/**, apps/orchestration-service/drizzle/0053_public_forms.sql, apps/orchestration-service/drizzle/rollback/0053_drop_public_forms.sql, apps/orchestration-service/drizzle/meta/_journal.json, apps/platform-api/src/triggers/**, apps/platform-web/src/api/live.ts, apps/platform-web/src/api/client.ts, apps/platform-web/src/api/types.ts, apps/platform-web/src/api/live-triggers.spec.ts, apps/platform-web/src/features/triggers/components/**, docker/Dockerfile.node, docker/node-entrypoint.sh, docker/README.md, deploy/ec2/**, infrastructure/local/engine-db-init.sh, infrastructure/terraform/**, scripts/check-engine-db-runtime-roles.sh, scripts/check-engine-test-discovery.mjs, scripts/gates/baseline.json, pnpm-lock.yaml, docs/public-forms.md, docs/work-queue.md

Scope: D16's hosted form is an explicit option alongside a user's own source, never created automatically. Its separate Public Surface process serves `/f/<token>` and accepts only validated, Turnstile-verified, rate-limited fields through the existing trigger event pipeline. Disabled/replaced/foreign forms cannot submit. No uploads. Reuse the shared D15 classifier. Preserve ordinary tenant RLS and downstream run permissions/budgets.

- [ ] G1: Authenticated authoring offers hosted form only by explicit choice, persists bounded form definitions on the trigger, returns its public link, and enforces role/current-version ownership when editing, disabling or replacing it
  CHECK: node .unlazy/verify-authoring.mjs
  EXPECT: public-form-authoring-passed
  EVIDENCE: pending

- [ ] G2: A real separate HTTP process renders only current enabled form fields safely; opaque token validation and ordinary PostgreSQL scope refuse unknown, changed, disabled and foreign definitions without exposing other trigger settings
  CHECK: node .unlazy/verify-public.mjs
  EXPECT: public-form-public-passed
  EVIDENCE: pending

- [ ] G3: Production Turnstile adapter verifies the submitted token and expected form context; failed/expired/repeated/invalid verification cannot dispatch, and missing configuration cannot become success
  CHECK: node .unlazy/verify-turnstile.mjs
  EXPECT: public-form-turnstile-passed
  EVIDENCE: pending

- [ ] G4: Real atomic rate counters enforce independent form and visitor limits across concurrent requests before expensive work, malformed fields/uploads are refused, and the shared D15 classifier blocks classified injection or unavailable classification
  CHECK: node .unlazy/verify-input.mjs
  EXPECT: public-form-input-passed
  EVIDENCE: pending

- [ ] G5: A valid native form submission reaches the existing canonical trigger pipeline and creates an attributed event/run under ordinary PostgreSQL; retries do not duplicate runs and disabled/held workflows remain refused
  CHECK: node .unlazy/verify-dispatch.mjs
  EXPECT: public-form-dispatch-passed
  EVIDENCE: pending

- [ ] G6: Live and mock setup controls preserve the own-source default, show/save hosted fields and public link only when selected, and surface failed/conflicting submissions without inventing success
  CHECK: node .unlazy/verify-web.mjs
  EXPECT: public-form-web-passed
  EVIDENCE: pending

- [ ] G7: Distinct production mutations fail behavioral assertions and restored controls pass
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: public-form-controls-passed
  EVIDENCE: pending

- [ ] G8: Full affected suites/coverage and static checks, separate production boot/routing and least-privilege bindings, paired migration/rollback, CI discovery, architecture/RBAC/naming and zero new normalized AST findings pass
  CHECK: node .unlazy/verify-final.mjs
  EXPECT: public-form-final-passed
  EVIDENCE: pending
