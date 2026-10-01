# Gates: D5 approval mode controls (C90)

OWNS: apps/platform-web/src/api/**, apps/platform-web/src/features/workflows/components/**, apps/platform-web/src/features/human-actions/**, apps/orchestration-service/src/approvals/approvals.service.ts, apps/orchestration-service/src/approvals/approval-context.integration.spec.ts, docs/work-queue.md

Scope: Live and mock users can view approval modes on the approval step and Action Centre, save with a current ETag and explicit consequence confirmation, configure skip windows, and see unapplied promotion suggestions and policy/timeout outcomes.

- [x] G6: Merged Nx env patch accepts the actual generated fixture; current architecture baseline passes
  CHECK: node scripts/check-nx-env-local.mjs && node scripts/gates/run-all.mjs && echo approval-post-merge-passed
  EXPECT: approval-post-merge-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=8b6873ab3849057d23ad717cdf43d553efdb080a1d8054e1c8f421e113c5280c; exit=0; EXPECT=matched; output-sha256=e864d69fc91d2f6c65e754ec90cb1f58f1c9bfc7bb97baa2a23e45106bace16f; output-bytes=1146; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-d5-web-c90; path=b33e9cf43ae9/31 entries

- [x] G1: Real Postgres approval reads expose the workflow and graph approval key with tenant isolation
  CHECK: node_modules/.bin/vitest run apps/orchestration-service/src/approvals/approval-context.integration.spec.ts && echo approval-context-passed
  EXPECT: approval-context-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=b96f66eabe0534608c4c14a55519e3454cf41bef654980ddcbc7a084bac85ad0; exit=0; EXPECT=matched; output-sha256=4181e1b63a3583a6af273da05d0bf1dc8ebd7f0764af0eeef156f6c7818e9a07; output-bytes=633; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-d5-web-c90; path=b33e9cf43ae9/31 entries

- [x] G2: Live adapter preserves policy metadata, preconditions and skipped lifecycle; mock mirrors it
  CHECK: node_modules/.bin/vitest run --config apps/platform-web/vitest.config.ts apps/platform-web/src/api/live-approval-policies.spec.ts apps/platform-web/src/api/live-human-actions.spec.ts apps/platform-web/src/api/mock/approval-policies.spec.ts && echo approval-adapters-passed
  EXPECT: approval-adapters-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=6a1e2e0102142357ebdc068869428db099ef77110388714e1d66d6217e3279b0; exit=0; EXPECT=matched; output-sha256=da4f1df459e539d20dcebabfa8b32f509e0a75dbcb9ae7e38677e4e6b80d23a3; output-bytes=262; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-d5-web-c90; path=b33e9cf43ae9/31 entries

- [x] G3: Rendered controls require explicit confirmation and rights, preserve settings and reload stale state
  CHECK: node_modules/.bin/vitest run --config apps/platform-web/vitest.config.ts apps/platform-web/src/features/workflows/components/approval-policy-controls.spec.tsx apps/platform-web/src/features/human-actions/components/approval-policy-section.spec.tsx && echo approval-controls-passed
  EXPECT: approval-controls-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=97c702b16e6b6b1633a2cb23c23fe6f7e0edd18f9866a1c5748eaee574e607dc; exit=0; EXPECT=matched; output-sha256=c5be4b96238fe0ff9a24f46b74e8caebec9dbe4f95661c86da134034362d5ecc; output-bytes=260; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-d5-web-c90; path=b33e9cf43ae9/31 entries

- [x] G4: Removing key enforcement fails behavioral regression controls
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: approval-ui-negative-controls-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=33bef0459a9f1e1c56dce5dc590e9d927e8d45d6e42d5393ab6040dc0cbe0570; exit=0; EXPECT=matched; output-sha256=ed96fb3364c88c6172d693406653d7fe12e12a5e11bedf30bd4f5862cfbb7af5; output-bytes=319; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-d5-web-c90; path=b33e9cf43ae9/31 entries

- [x] G5: Full web and engine tests, static checks, architecture and unchanged AST baseline pass
  CHECK: node .unlazy/verify-full.mjs
  EXPECT: approval-ui-full-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=3550bf73d0be50156a4c09695cadd4d3654fe09f0a9298dbb803fa0c668c6e31; exit=0; EXPECT=matched; output-sha256=47d7ebce6d0db18da156321cffc19e7ee5b799e3200c83496cf372cefb7bb944; output-bytes=173; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-d5-web-c90; path=b33e9cf43ae9/31 entries
