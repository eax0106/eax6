# Gates: D17 identity gateway naming (C107)

OWNS: scripts/check-identity-names.sh, scripts/check-identity-names.mjs, scripts/check-identity-names.spec.mjs, scripts/identity-names-baseline.json, .github/workflows/ci.yml, AGENTS.md, docs/work-queue.md

Scope: Block the retired identity gateway phrase and identifier spelling in added source/document lines. Preserve existing occurrences as a measured historical inventory; that inventory never excuses an added occurrence. CI runs the actual shell entry point and the native regression fixtures.

- [x] G1: The actual gate permits unchanged historical occurrences and current names, and refuses newly added retired phrases or identifiers in committed, staged and working changes
  CHECK: node scripts/check-identity-names.spec.mjs
  EXPECT: identity-name-native-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=a9067d6f33010e76770dab962444967fd9e060856f42f2894d28dfba07bd21f2; exit=0; EXPECT=matched; output-sha256=ba878eb02f8261d6c1b4467cef74b01fb0798e465f8482bdabfe2cc31e0c88b2; output-bytes=28; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-identity-name-gate-c107; path=b33e9cf43ae9/31 entries

- [x] G2: Disabling added-line validation makes the native regression fixture fail, and restored source passes
  CHECK: node .unlazy/negative-control.mjs
  EXPECT: identity-name-negative-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=7c1c01fcb56bee764cb99c8bbbfd01bdc0bb3884fa8c73a8a3426d4226b38901; exit=0; EXPECT=matched; output-sha256=104798181212444e265005c63183ea98440d23ae28afec51e46bb1482f12703a; output-bytes=30; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-identity-name-gate-c107; path=b33e9cf43ae9/31 entries

- [x] G3: Historical inventory counts are independently measured against the recorded Git revision and CI runs both the actual shell gate and native regression fixtures without a conditional skip
  CHECK: node .unlazy/verify-wiring.mjs
  EXPECT: identity-name-wiring-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=dd5a45a20ba84207e02266e5b86fde88133e37796fc5c4d35b29e157ce23e245; exit=0; EXPECT=matched; output-sha256=755dbdc364a13d982e0a35239c5e874c177698e333e1b231266adcdcabc5fa18; output-bytes=67; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-identity-name-gate-c107; path=b33e9cf43ae9/31 entries

- [x] G4: Current branch naming, shell syntax, architecture, RBAC, rollback pairing and unchanged AST findings pass
  CHECK: node .unlazy/verify-final.mjs
  EXPECT: identity-name-final-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=3ff759ccf1725434409285e8ce64c3726700bb6d11ae0346948160adcc247f45; exit=0; EXPECT=matched; output-sha256=01954bc1248b8b852c39a85a50563079e9c7ebdf944b1d45a6cf2278cc0b60f7; output-bytes=27; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-identity-name-gate-c107; path=b33e9cf43ae9/31 entries
