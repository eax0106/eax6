# Gates: D14 read-back (C94)

OWNS: apps/orchestration-service/src/**, apps/orchestration-service/drizzle/**, apps/platform-api/src/notifications/engine-events/**, apps/tool-gateway/src/gateway/**, packages/adapters/src/ses/**, packages/shared-clients/src/**, packages/contracts/src/workflow-dag.ts, deploy/ec2/**, infrastructure/ec2-mvp/**, docs/work-queue.md

Scope: D14 acceptance passes immediately; SES Delivery/Bounce updates the matching side-effect atomically and a later bounce flags the run and reaches D1 notifications. Click reads expected page state only when declared, with confirmation persisted for the existing verification view. EC2 kit provisions the event route; actual AWS deployment awaits the deployment account.

- [x] G7: Unconfirmed browser actions persist a warning that the live adapter and rendered verification view label explicitly
  CHECK: node_modules/.bin/vitest run apps/orchestration-service/src/registry/nodeexec.service.spec.ts apps/orchestration-service/src/webhooks/ses-delivery-events.integration.spec.ts && node_modules/.bin/vitest run --config apps/platform-web/vitest.config.ts apps/platform-web/src/features/runs/components/run-inspector.spec.tsx && echo readback-visible-passed
  EXPECT: readback-visible-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=d8409783f8a07812ba616dad386d392ad02e8db793d4002c1d6896a148f1fb5d; exit=0; EXPECT=matched; output-sha256=d98cd761b21999658634287b00c18316294bc506fec67a12de2365e0cbc07aa1; output-bytes=2951; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-d14-readback-c94; path=b33e9cf43ae9/31 entries

- [x] G1: Restricted-role Postgres proves delivery, bounce, duplicates, order, tenant isolation, early-event retry and atomic stream rollback; real HTTP proves authentication and retry status
  CHECK: node_modules/.bin/vitest run apps/orchestration-service/src/webhooks/ses-delivery-events.integration.spec.ts apps/orchestration-service/src/webhooks/ses-delivery-events.controller.spec.ts apps/orchestration-service/src/webhooks/ses-delivery-events.service.spec.ts && echo ses-readback-passed
  EXPECT: ses-readback-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=e60db4d80c1ed5648adce68d76da8178ebddbec31d83774f25452144eb3f35b1; exit=0; EXPECT=matched; output-sha256=151999867f729663d491f5fa7dce1f7c18ba0268abf87bb47d86db95d7b28f42; output-bytes=2705; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-d14-readback-c94; path=b33e9cf43ae9/31 entries

- [x] G2: D1 producer uses delivery failure time and per-side-effect deduplication, including old runs
  CHECK: node_modules/.bin/vitest run apps/platform-api/src/notifications/engine-events/email-delivery-failed.producer.spec.ts && echo d1-delivery-notification-passed
  EXPECT: d1-delivery-notification-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=fb196991f4f3b304362c8b8f3e5608341d83fd259780781c25483f7819cc58bf; exit=0; EXPECT=matched; output-sha256=7ee3cba125c2b5e4fc7cd0c7cd9b15a66bc397f8dad606097af61af091b2e046; output-bytes=874; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-d14-readback-c94; path=b33e9cf43ae9/31 entries

- [x] G3: Clicks without expectations make no read-back call; text/selector checks confirm, fail or remain unconfirmed honestly
  CHECK: node_modules/.bin/vitest run apps/tool-gateway/src/gateway/tool-gateway.service.spec.ts apps/orchestration-service/src/registry/mechanical-check.spec.ts apps/orchestration-service/src/registry/handlers/toolcall.handler.spec.ts && echo browser-readback-passed
  EXPECT: browser-readback-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=e44e6620b7edf607ee2082a694fef7e47b4f2c6141a1d11841a3fda994d6b77b; exit=0; EXPECT=matched; output-sha256=14ff391afe0a208389860f276fdc964c9d9b81cc0538b91f9e121e81955e9c8e; output-bytes=641; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-d14-readback-c94; path=b33e9cf43ae9/31 entries

- [x] G4: Removing delivery updates, notification identity or conditional snapshots fails behavioral assertions and restores all sources
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: d14-negative-controls-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=8ecf3a6515c9e80b0a42f1955499fcb7b6ed52171e0eb36d8c674c3a235649ea; exit=0; EXPECT=matched; output-sha256=ad521332f6c9a1341b0eca04416761ccb7a03b7fd18e5082e77fe6ce5a6ccb9b; output-bytes=594; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-d14-readback-c94; path=b33e9cf43ae9/31 entries

- [x] G5: EC2 kit routes SES events to authenticated engine with retries and a dead-letter queue; local provisioner controls pass
  CHECK: python3 deploy/ec2/check-ses-delivery.py && bash deploy/ec2/check-bootstrap-env.sh && terraform -chdir=infrastructure/ec2-mvp validate
  EXPECT: ses-delivery-kit-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=785a234dfbe1dae4df08022f484bac31a17f213a08329cd5ed75f399098e21af; exit=0; EXPECT=matched; output-sha256=80d6d381a93a1f1239213562fbc777e66952de999b65183e1d9f52ec4d443702; output-bytes=150; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-d14-readback-c94; path=b33e9cf43ae9/31 entries

- [x] G6: Builds, typecheck, lint, affected suites, architecture and zero new AST entries pass
  CHECK: node .unlazy/verify-full.mjs
  EXPECT: d14-full-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=cd33a59db1f310d2a9722c5eab02b7cdf1c5017f6f0a802e7b5a67604cbd8319; exit=0; EXPECT=matched; output-sha256=56d0c842af7a00d0c35f7dbaaf5cd3fba302846a827e3041d6c800f74f7e589d; output-bytes=372; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-d14-readback-c94; path=b33e9cf43ae9/31 entries
