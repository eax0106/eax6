# Gates: Nx root env regression (C93, L33)

OWNS: scripts/check-nx-env-local.mjs, .github/workflows/ci.yml, package.json, pnpm-lock.yaml, patches/**, docs/work-queue.md

Scope: A minimal dotenv-expand dependency patch makes Nx load generated self-referential shell-default root env values without looping. CI keeps that generated fixture present for its Nx build, lint, typecheck and test commands. Existing local env files are never overwritten.

- [x] G1: Actual Nx project graph and command execution accept root env defaults with loading enabled
  CHECK: node scripts/check-nx-env-local.mjs
  EXPECT: nx-env-local-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=0cbeab36c7100eeb7602f57ee9668dd7b97871d9ef03baacb094acee53063bc1; exit=0; EXPECT=matched; output-sha256=df86b51e203a4a1437ce362d7383bdf1078f993a5f9d4ecd0baf66fe3f63a40f; output-bytes=33; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-nx-env-c93; path=b33e9cf43ae9/31 entries

- [x] G2: Wrong inherited values fail the child assertion and original expansion loops on the same positive fixture
  CHECK: node .unlazy/negative-control.mjs
  EXPECT: nx-env-negative-control-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=f59ae6701a3349d9c9f9d3d448c17e37018fe9eeebd4c009598ddc81aba7181a; exit=0; EXPECT=matched; output-sha256=0e05d8a9473648d664bf81b03b305e421740eef63ed8d5a1512d46b7e095f3bf; output-bytes=31; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-nx-env-c93; path=b33e9cf43ae9/31 entries

- [x] G3: CI installs the fixture before Nx checks and cleans it on every outcome; architecture and AST baseline pass
  CHECK: node .unlazy/verify-static.mjs
  EXPECT: nx-env-static-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=5528236b3b5e6ed349646eb2d7204e6a715e3432a6f9a8f86ab0ed2c4efc3dc6; exit=0; EXPECT=matched; output-sha256=1d0d039cc49e9f71b2c10e31814dff7aacd94d2a59817dbdda1dd206ce62b239; output-bytes=21; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-nx-env-c93; path=b33e9cf43ae9/31 entries
