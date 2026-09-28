# Memory & Learning

**Layer** L8 · **Plane** memory · **Category** 3 — needs fixes or missing methods

> Both ends exist and the call is made, and something along the path is wrong. A source read marks
> these as finished, because from the source both halves look complete.

## What it is

Summarises what happened in a run into something the engine can learn from, and feeds the Policy Store.

## Blast radius, fail mode and driver

**Contract 32 — Memory & Learning** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | degraded (self only). Learning stops; runs are entirely unaffected. |
| Fail mode | fail-closed on writes. Never record learning whose provenance cannot be confirmed. |
| Driver | invoked on verified run completion. *Driver test:* a verified run produces a learning candidate; **a failed run produces none.** |

*From the contract (task C13, decision 0.7). The contract's done gates are targets, not gates that fail today.*

## Where the code lives

- `apps/memory-service/src/memory_learning`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

**No single credential reaches both ends**: the service token memory requires is rejected by the orchestration endpoint it forwards to, and the M2M token that endpoint wants is rejected by memory.

## Design-log alignment — `SILENT`

**The design log has no answer here.** It covers user authentication thoroughly (§20 — managed identity provider, never hand-rolled, RS256 pinned at both the header check and the key-import filter) and **never addresses service-to-service auth topology at all**.

This is not a missing method on one service. Memory authenticates a caller with the internal service token and then forwards that same header onward, to an endpoint that requires an M2M token it cannot mint. **It is a cycle that crosses an authentication boundary**, which is why no single credential closes it. Minting a tenant-scoped token is off the table by design: #113 removed the `organization` parameter because an Alter tenant UUID was never a valid namespace against real Auth0.

Either that endpoint accepts a tenant explicitly alongside a service credential, or the cycle stays. **Decision 0.1, blocked on Havish, blocking all of Phase 2.**

## Decision — 2026-09-08 · design log §30

**Internal service endpoints accept an explicit tenant alongside a service credential.** Memory stops discarding `tenant_id` at `orchestration_client.py:51` and sends it; orchestration's `/internal/` routes accept it.

Three requirements, and the second and third are what make the first safe:

1. **Authenticate the asserter** — the caller proves it holds the service credential.
2. **Verify the assertion against data we already own** — the asserted tenant must match the tenant the addressed run belongs to. `run-outcome.service.ts:236` already queries `WHERE tenant_id = $1 AND run_id = $2` inside `withTenant()`, so a wrong assertion already returns nothing — but as an indistinguishable "not found". **It must refuse explicitly, with a named reason.**
3. **Audit every service-asserted tenant** — the shared credential is the weak point; the trail is what makes a leak recoverable.

**Stated limitation.** Every service presents the same shared token today, so this authenticates *that the caller is an Alter service*, not *which one*. Design log §2's tenant isolation therefore rests on that secret plus requirement 2. Acceptable now; tightens to per-service RS256 verification when M2M applications exist, with call sites unchanged.

Rationale and rejected alternatives: [`phase-0-decisions.md` §0.1](../../phase-0-decisions.md). Implementation is task 2.1.

## What the finished component looks like

- [ ] The credential edge implemented per decision 0.1 — if the endpoint takes an explicit tenant, that is an additive parameter plus a guard that it matches the service credential's scope.
- [ ] A failed run produces a memory record, demonstrated live as part of Phase 2's full circuit.

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md).

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
