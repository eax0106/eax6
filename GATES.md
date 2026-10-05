# Gates: Temporal rollover test readiness (C131)

OWNS: packages/adapters/src/temporal/workflows/conversation-lifecycle-workflow.spec.ts, docs/work-queue.md

Scope: Make the existing rollover regression exercise a running workflow by waiting for its actual active query before sending the two rollover messages. Retain every existing rollover, preserved-message, deduplication and closure assertion. The separately recorded buffered-start production behavior is unchanged. No production workflow, dependency or contract change.

- [x] G1: The actual Temporal rollover case passes in three independent native environments, and the full adapter suite, lint, typecheck and build pass
  CHECK: node .unlazy/verify-temporal-readiness.mjs
  EXPECT: temporal-readiness-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=1eb618d1041ba8014e6cc7e897e66393fed70cadb708ffb8479ffb010834d2d0; exit=0; EXPECT=matched; output-sha256=bce21e4e71eac3a8e50e394a9bf75adeb8c77ede61de50637e7eee08b688943b; output-bytes=389; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-temporal-ci-c131; path=2b1f1cc87037/31 entries

- [x] G2: Directly read CI evidence binds two normal rollover failures to unchanged production and prior test source; the final diff changes only the declared test readiness and work-queue records, without weakening any existing assertion
  CHECK: node .unlazy/verify-temporal-evidence.mjs
  EXPECT: temporal-readiness-evidence-passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=053d39eccc8b191ab12c589c66d4407fd4b82c11e018a5784ce7600515086e41; exit=0; EXPECT=matched; output-sha256=31307f13659013a035bfdcabd882be22b789ab02f0c6be2102568983b5deacb5; output-bytes=56; shell=/bin/sh; cwd=/Users/havishvardhan/alter-work/alter-temporal-ci-c131; path=2b1f1cc87037/31 entries
