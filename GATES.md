# Gates: workspace-aware WhatsApp account routes (C102)

OWNS: apps/orchestration-service/src/webhooks/whatsapp-accounts.controller.ts, apps/orchestration-service/src/webhooks/whatsapp-account-registry.service.ts, apps/orchestration-service/src/webhooks/whatsapp-accounts.controller.spec.ts, apps/orchestration-service/src/webhooks/whatsapp-account-delete.integration.spec.ts, apps/orchestration-service/src/webhooks/whatsapp-workspace.integration.spec.ts, apps/platform-api/src/channels/whatsapp/whatsapp.service.ts, apps/platform-api/src/channels/whatsapp/whatsapp.isolation.spec.ts, apps/platform-api/src/channels/whatsapp/whatsapp-test-send.spec.ts, docs/work-queue.md, scripts/gates/baseline.json

Scope: Carry the authenticated workspace through account creation, listing and configuration SQL. Reuse the existing account lookup and provider operations. Native engine HTTP proof uses signed tokens, Redis replay protection and restricted PostgreSQL; the platform provider edge remains a local fixture. No account creation or external send.

- [x] G1: Native signed HTTP and restricted PostgreSQL exercise account registration, listing, configuration and deletion within the authenticated workspace
  CHECK: node .unlazy/verify-engine.mjs
  EXPECT: whatsapp-workspace-engine-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=976d8cd9a72ca5d8b282f36b1eb5c88755a3667fb872c0b0a7989faa29a3bb4b; exit=0; EXPECT=matched; output-sha256=049e94db62513cef34e8c8b6384d9dc79bc6ac72731b0fa1d0db5e83c0c02141; output-bytes=87; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-whatsapp-scope-c102; path=b33e9cf43ae9/31 entries

- [x] G2: Platform account and escalation reads use the caller workspace, with provider/configuration operations denied before any external edge is touched
  CHECK: node .unlazy/verify-platform.mjs
  EXPECT: whatsapp-workspace-platform-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=086a521bdabd50f23a04bea876d44a8cc0b01c3501dcfd1489ca7c623afd3b23; exit=0; EXPECT=matched; output-sha256=162e943dfd4cac61e138bcf19951ba1858ab378854c188f68f27d5b9bca53139; output-bytes=89; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-whatsapp-scope-c102; path=b33e9cf43ae9/31 entries

- [x] G3: Original route/SQL behavior and removed platform list filtering fail the same assertions; restored sources pass
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: whatsapp-workspace-negative-controls-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=f79b851d7a3422d3a55708dae023fb7bfcbff83ff7388349cc8054a523607910; exit=0; EXPECT=matched; output-sha256=13c5994a38584d5e029311d3268c7c49f26283b3842174ffdd8da97ac81fda88; output-bytes=358; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-whatsapp-scope-c102; path=b33e9cf43ae9/31 entries

- [ ] G4: Full engine and platform suites with coverage, static checks, architecture, RBAC, migration pairing and zero added AST findings pass
  CHECK: node .unlazy/verify-full.mjs
  EXPECT: whatsapp-workspace-full-passed
