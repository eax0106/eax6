# Gates: WhatsApp test-send form (C98)

OWNS: apps/platform-web/src/api/**, apps/platform-web/src/features/connections/pages/whatsapp-channel*, apps/platform-api/src/channels/whatsapp/**, docs/work-queue.md, scripts/gates/baseline.json

Scope: Existing accounts can send a test template to an explicitly entered recipient through the existing guarded route. The form uses approved templates and their language, keeps one request key across retries, shows actual provider acceptance or errors, and handles accounts without a creation date.

- [x] G1: Rendered live UI and HTTP adapter prove recipient/template selection, confirmation, provider response, failed retries and permission controls
  CHECK: node_modules/.bin/vitest run --config apps/platform-web/vitest.config.ts apps/platform-web/src/api/live-whatsapp.spec.ts apps/platform-web/src/features/connections/pages/whatsapp-channel.spec.tsx && echo whatsapp-test-send-surface-passed
  EXPECT: whatsapp-test-send-surface-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=5c6633fd370dcbeeab464d6a19cc0936d6a17aeef6ce9309eba730ada3f16abc; exit=0; EXPECT=matched; output-sha256=9157a93669b2a924be4570a7a4bcea977ff6b4f1f6457421e6a193e9aa607cd1; output-bytes=276; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-whatsapp-test-c98; path=b33e9cf43ae9/31 entries

- [x] G2: Guarded platform HTTP with real PostgreSQL idempotency and the real Meta provider proves validation, caller scope, language and one accepted send per request
  CHECK: node .unlazy/verify-platform.mjs
  EXPECT: whatsapp-test-send-platform-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=8fb140193bcbce5c288e8040ccb077d20806ae8f5bcbcfeb8ca68e2998a18a7b; exit=0; EXPECT=matched; output-sha256=7ab1f65527019e3216ba1e1589a4ff7414757f128fa024c95d2e5d3d0969b4ac; output-bytes=213; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-whatsapp-test-c98; path=b33e9cf43ae9/31 entries

- [x] G3: Original-code and mutation controls fail their corresponding assertions and restore every source
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: whatsapp-test-send-negative-controls-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=a14fc89a34eaf1122940b179214a176ee2c2619aacf9b3a35c3270a8f02f4996; exit=0; EXPECT=matched; output-sha256=14868745ffedaaa388b44acf6a66b0e15896d96584b53ba367fd8b19ddf22e2b; output-bytes=264; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-whatsapp-test-c98; path=b33e9cf43ae9/31 entries

- [x] G4: Affected builds, typechecks, lint, full web and platform coverage, architecture, RBAC and zero added AST findings pass
  CHECK: node .unlazy/verify-full.mjs
  EXPECT: whatsapp-test-send-full-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=c931887db21ed46600b64a6b9f25da2a185ec651eb7b67a6c8a8bdbcb023912f; exit=0; EXPECT=matched; output-sha256=f6fff9e6f472fff547895d50e9af54fce9afc57f7616b2ab5c68797c69caf62c; output-bytes=303; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-whatsapp-test-c98; path=b33e9cf43ae9/31 entries
