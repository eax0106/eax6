# Work queue — Phase 6, then Tracks B, C, D

Opened 2026-09-28 on Havish's instruction: finish the buildable part of Phase 6, then
conclude Track B, Track C and Track D, **one after another, nothing skipped**. Anything that
needs Havish's decision is not built on a guess — it moves to "Blocked on a decision" below and
is asked once everything buildable is done.

This file is the execution order. `checklist.md` stays the board; every item here is also an
item there. Status: `todo` · `doing` · `done (PR #n)` · `blocked (reason)`.

## Order

### Phase 6 — buildable part
| # | Item | Status |
|---|---|---|
| 6.1a | Single-EC2 deployment kit: one compose file for all 14 services, databases, Redis, Presidio and the web bundle; env template for real AWS; bootstrap that migrates every database; runbook. Proven by running it end to end on one machine. | todo |
| 6.2a | Temporal Cloud wiring in the kit (address, namespace, API key reference, versioned workers from #222). | todo |
| 6.1b | Launch on EC2 | blocked (accounts + cost, below) |
| 6.2b | Run against Temporal Cloud | blocked (account) |
| 6.5 | Load and failure evidence; promotion gate | blocked (needs 6.1b) |

### Track B — platform wiring
| # | Item | Status |
|---|---|---|
| B1.1 | admin-tenants | todo |
| B1.2 | admin-users | todo |
| B1.3 | audit | todo |
| B1.4 | feature-flags | todo |
| B1.5 | incidents | todo |
| B1.6 | policies | todo |
| B1.7 | providers | todo |
| B1.8 | security | todo |
| B1.9 | support-access | todo |
| B1.10 | usage | todo |
| B1.11 | deployments (admin service) | todo |
| B2.1 | marketplace-admin | todo |
| B2.2 | billing-ops | todo |
| B2.3 | checkout | todo |
| B2.4 | KYC / document review | todo |
| B2.5 | tax / fee settlement | todo |
| B2.6 | tokenized card setup | todo |
| B2.7 | invoice PDF | todo |
| B2.8 | new subscription | todo |
| B3.1 | notifications | todo |
| B3.2 | benchmarks | todo |
| B3.3 | discovery | todo |
| B3.4 | server search beyond listing/tool | todo |
| B3.5 | Tool Registry, confirm live | todo |
| B3.6 | Media Services, confirm live | todo |

Each B item: backend route exists and is wired, `isLiveApi` path added, the live-mode hide
policy from #212 lifted for it only when its live adapter is verified.

### Track C — design-log compatibility
| # | Item | Status |
|---|---|---|
| C29 | slice 2b: criteria to the producing node and the gate | todo |
| C1 | 11 AST architecture gates with a baseline | todo |
| C3 | deletion registration in CI | todo |
| C5 | cost ledger records verification verdicts | todo |
| C8 | side-effect ledger and idempotency gate before Dispatch | todo |
| C10 | Run Manager atomic budget gate | todo |
| C9 | reviewer isolation against prompt injection | todo |
| C11 | Policy Store global tier | todo |
| C36 | §5.2 mechanical read-back (no board item until now) | todo |
| C37 | §5.3 end-of-run holistic check (no board item until now) | todo |
| C38 | §19 Capability Registry workflow templates (no board item until now) | todo |
| C39 | §17 Drift Detector outbound suggestion path (no board item until now) | todo |
| C4 | safety as a shared in-process library | todo |
| C7 | Agent Factory extracted | todo |
| C18 | re-embed backfill | todo |
| C13 | map 54 contracts onto 61 components | todo |
| C33 | deterministic wait in the flaky Temporal test | todo |
| C34 | specs authorize through the enforcing resolver | todo |
| C35 | vitest hang with `.env.local` present | todo |
| C30 | §16 approval modes | blocked (decision) |
| C32 | image publishing collision | blocked (decision) |

### Track D — design-log conformance (last)
| # | Item | Status |
|---|---|---|
| D1 | whole log against whole system, incl. rules adopted from alter-x-4- | todo |
| D2 | record every divergence before fixing | todo |
| D3 | allow "amend the log" as a conclusion | todo |

## Blocked on a decision or an account — asked at the end

| Item | What is needed from Havish |
|---|---|
| 6.1b | Auth0 tenant (real sign-in), EC2 size and monthly cost approval, domain for HTTPS |
| 6.2b | Temporal Cloud account and API key in Secrets Manager |
| 5.2 live proof | GitHub OAuth app, client id/secret in Secrets Manager |
| C30 | Build §16's four approval modes, or amend §16; plus open question 8 (notification channel) |
| C32 | Grant this repository write on the GHCR packages, rename our images, or turn `images` publishing off here |
