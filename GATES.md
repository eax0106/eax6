# Gates: D14 read-back (C94)

OWNS: apps/orchestration-service/src/webhooks/ses-delivery-events.*, apps/orchestration-service/src/runs/node-execution-ledger.service.ts, apps/orchestration-service/src/registry/mechanical-check.ts, apps/tool-gateway/src/gateway/tool-gateway.service.ts, packages/adapters/src/ses/**, packages/contracts/src/workflow-dag.ts, docs/work-queue.md

Scope: SES delivery and bounce read-back plus conditional browser click snapshots.

- [ ] G1: SES events parse, authenticate at the route, match the provider id, fail the run and append a durable status
  CHECK: node_modules/.bin/vitest run apps/orchestration-service/src/webhooks/ses-delivery-events.service.spec.ts apps/orchestration-service/src/webhooks/ses-delivery-events.controller.spec.ts && echo ses-readback-passed
  EXPECT: ses-readback-passed

- [ ] G2: the existing system caller can notify failed delivery runs
  CHECK: node_modules/.bin/vitest run apps/platform-api/src/notifications/engine-events/run-failed.producer.spec.ts && echo d1-delivery-notification-passed
  EXPECT: d1-delivery-notification-passed

- [ ] G3: browser.click snapshots and conditionally confirms expected state
  CHECK: node_modules/.bin/vitest run apps/tool-gateway/src/gateway/tool-gateway.service.spec.ts apps/orchestration-service/src/registry/mechanical-check.spec.ts apps/orchestration-service/src/registry/handlers/toolcall.handler.spec.ts && echo browser-readback-passed
  EXPECT: browser-readback-passed

- [ ] G4: malformed and missing-state controls remain explicit failures/unconfirmed results
  CHECK: node_modules/.bin/vitest run apps/orchestration-service/src/webhooks/ses-delivery-events.service.spec.ts apps/orchestration-service/src/registry/mechanical-check.spec.ts && echo d14-negative-controls-passed
  EXPECT: d14-negative-controls-passed

- [ ] G5: full verification
  CHECK: node .unlazy/verify-full.mjs
  EXPECT: d14-full-passed
