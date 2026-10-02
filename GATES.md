# Gates: platform runtime function grants (C103)

OWNS: deploy/ec2/platform-db-roles.sql, deploy/ec2/check-platform-db-roles.sh, docs/work-queue.md

Scope: Apply explicit tenant and staff function grants using the existing runtime-role kit and strengthen its existing CI check. Exercise the complete migration set on a fresh native PostgreSQL instance before and after the role kit. No deployed database or external account is touched.

- [x] G1: Native PostgreSQL applies the production role kit before and after all migrations; the existing check proves tenant, staff, signup and retention behavior twice
  CHECK: node .unlazy/verify-roles.mjs
  EXPECT: platform-function-grants-native-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=164bb3f3e794fdffe14ca1822f4b704e0bba4d237331890bfbe6aec967ec74a1; exit=0; EXPECT=matched; output-sha256=d34261fd3505fb43305a1f104904200a469ef5c4c253146077d64d0bfe2ba4f7; output-bytes=120; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-platform-function-grants-c103; path=b33e9cf43ae9/31 entries

- [x] G2: Restoring the prior grant behavior makes the strengthened role check fail; restored sources pass again
  CHECK: node .unlazy/negative-controls.mjs
  EXPECT: platform-function-grants-negative-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=d1dc966870eb848934518555fce285246d0a0b0e3f90d69cffa3e2764679787c; exit=0; EXPECT=matched; output-sha256=a17ecc960f582f2835b7b16f628681082184da990b1721d6958c4b2ec85cd14e; output-bytes=94; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-platform-function-grants-c103; path=b33e9cf43ae9/31 entries

- [x] G3: Shell syntax, bootstrap configuration, production boot, architecture, rollback pairing and existing CI wiring pass
  CHECK: node .unlazy/verify-wiring.mjs
  EXPECT: platform-function-grants-wiring-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=a249f4177cf1d3b51920bec7b95dc29b3a342a0a6ddd0581e385efa892f91255; exit=0; EXPECT=matched; output-sha256=39e4b26cbdc21db6b2bb6443b906141d84f2328cd70c27ca4831d92145342568; output-bytes=39; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-platform-function-grants-c103; path=b33e9cf43ae9/31 entries
