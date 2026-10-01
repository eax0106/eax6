# Gates: knowledge document deletion (C96)

OWNS: apps/platform-web/src/features/knowledge/components/document-list*, apps/platform-web/src/api/client.ts, apps/platform-web/src/api/live.ts, apps/platform-web/src/api/live-knowledge.spec.ts, apps/platform-web/src/api/knowledge-delete-mock.spec.ts, docs/work-queue.md

Scope: Each knowledge document has a confirmed delete action through the existing tenant/workspace guarded endpoint. Success refreshes documents and source counts; failure keeps the row and displays an error. Mock behavior removes only the requested document.

- [x] G1: Rendered live document rows confirm before deletion, send the actual route, refresh on success and preserve the row on failure
  CHECK: node_modules/.bin/vitest run --config apps/platform-web/vitest.config.ts apps/platform-web/src/features/knowledge/components/document-list.spec.tsx apps/platform-web/src/api/live-knowledge.spec.ts && echo knowledge-delete-live-passed
  EXPECT: knowledge-delete-live-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=f1449af0b3e5e6e7cfef8d7efebcd6910707150bedc0f805abddf7191b64e4e6; exit=0; EXPECT=matched; output-sha256=3965597e05176e8e77b831a89dd9deaee35f5236cf5a9d3ba700c332dce87f35; output-bytes=274; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-knowledge-delete-c96; path=b33e9cf43ae9/31 entries

- [x] G2: Mock deletion removes only its selected document and refreshes source counts
  CHECK: node_modules/.bin/vitest run --config apps/platform-web/vitest.config.ts apps/platform-web/src/api/knowledge-delete-mock.spec.ts && echo knowledge-delete-mock-passed
  EXPECT: knowledge-delete-mock-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=f18e2a60ac71b2e666c859f1d52b8f016c9434c497b0df9b47b918d5cb522a5f; exit=0; EXPECT=matched; output-sha256=6469ede1c6d0782a0aef0abb94e41601070cc1fecfda4b56172c45665d228a81; output-bytes=274; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-knowledge-delete-c96; path=b33e9cf43ae9/31 entries

- [x] G3: The original component and broken route fail regression assertions and sources are restored
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: knowledge-delete-negative-controls-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=72d413d02c020ba8e3b5db4db6333dd7dd559a5a912b985d0ff8a26981ac7d3f; exit=0; EXPECT=matched; output-sha256=50da1953d948b2db44ddb807d44203246bc52ef4d9477d2a11f52f1373f37cfc; output-bytes=269; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-knowledge-delete-c96; path=b33e9cf43ae9/31 entries

- [x] G4: Full web suite, build, typecheck, lint, architecture and zero added AST findings pass
  CHECK: node .unlazy/verify-full.mjs
  EXPECT: knowledge-delete-full-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=7987f04d64befdeff0638ed4621ed900838e182887272a517004b8142c2d7838; exit=0; EXPECT=matched; output-sha256=60ff17aae8133ed31684bc623a166901ede26355df776b7c9b71cc5dfd99db59; output-bytes=221; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-knowledge-delete-c96; path=b33e9cf43ae9/31 entries
