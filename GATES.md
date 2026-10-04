# Gates: D26 retired admin UI choices (C123)

OWNS: GATES.md, scripts/gates/baseline.json, apps/platform-web/src/features/admin/pages/tenants/**, apps/platform-web/src/features/admin/pages/users/**, apps/platform-web/src/features/admin/pages/governance/policies-list.tsx, apps/platform-web/src/features/admin/pages/operations/providers-list.tsx, apps/platform-web/src/features/admin/pages/retired-controls.spec.tsx, apps/platform-web/src/api/types.ts, apps/platform-web/src/api/services/admin-tenants.ts, apps/platform-web/src/api/services/admin-users.ts, apps/platform-web/src/api/services/providers.ts, apps/platform-web/src/api/live-admin-users.spec.ts, docs/work-queue.md

Scope: Implement D26's approved removals in both live and demo admin UI: no restricted tenant state, MFA/risk display, provider maintenance control or list-page policy editing; user security links to Auth0, existing suspension and provider enable/disable remain functional. D26's independent backend additions remain on the root roadmap.

- [x] G1: Rendered admin surfaces omit retired controls, retain Auth0 link and working supported provider and tenant actions in live and demo modes
  CHECK: node .unlazy/verify-ui.mjs
  EXPECT: admin-removals-ui-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=d0d3c3ae867522db8488859f917a9c3c1250f835666f4449bdc437258d9e0e9c; exit=0; EXPECT=matched; output-sha256=27be41c116f072adcf76bdfd2916f3b160a1340af94f60b52cae909863ee9f85; output-bytes=77; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-admin-ui-c123; path=2b1f1cc87037/31 entries

- [x] G2: Full web suite and web lint, typecheck and build pass
  CHECK: node .unlazy/verify-regression.mjs
  EXPECT: admin-removals-regression-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=20c9183ebe4e2e0063de1629f88d241a994f5a681ef468ccb1369675a3b4a724; exit=0; EXPECT=matched; output-sha256=79db6d54e316b345f08a70c844f36def5dadf3b5612a9a3d174ab5de67a318a0; output-bytes=196; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-admin-ui-c123; path=2b1f1cc87037/31 entries

- [x] G3: Tests reject the original UI and pass restored changes; architecture and normalized AST checks pass with no new findings
  CHECK: node .unlazy/verify-final.mjs
  EXPECT: admin-removals-final-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=b5669e546b871412586e55863240664ab5573a21dc1ce66f1a9e48af3ad17ead; exit=0; EXPECT=matched; output-sha256=b5bc84fbf8ef9d19cd30ba37810b2e885847cec2b67d6653f21ef82268872511; output-bytes=230; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-admin-ui-c123; path=2b1f1cc87037/31 entries
