# Run Manager

**Layer** L6 · **Plane** orchestration · **Category** 1 — works end to end

> **Do not change this component's logic or code during revival.** It is one of the 25 verified
> end to end on 4–6 September 2026, and it is the only verified value in the system. Anything
> necessary is recorded in [`memoryalter.md`](../../memoryalter.md) *before* it is made.

## What it is

Decides whether a run starts, queues it, and dispatches it to the durable substrate. It does not walk the graph node by node — that is the Executor's job. Run Manager owns the moment a run comes into existence and the decision of whether it is allowed to.

## Blast radius, fail mode and driver

**Contract 16 — Run Manager** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | this-layer-only, but severe: no new runs start. Runs already executing on the Durable Substrate continue; the design path is unaffected. |
| Fail mode | fail-closed. A run that cannot be safely started is not started, and is recorded as failed rather than left silently pending. |
| Driver | event pickup and manual requests drive enqueue. **Dispatch requires its own real scheduler** — a background sweeper draining per active tenant on an interval, with a tenant-fairness policy above it. *Driver test:* **a queued run is dispatched with no further launches happening anywhere in the system.** This single test would have caught the largest finding in the old build's audit. |

*From the contract (task C13, decision 0.7). The contract's done gates are targets, not gates that fail today.*

## Where the code lives

- `apps/orchestration-service/src/runs`
- `apps/orchestration-service/src/run-launcher.module.ts`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

Nine runs dispatched, all reached `completed`. Idempotent replay of a used key correctly returns a no-op.

## Design-log alignment — `NEEDS-LOGIC`

Design log §22 assigns Run Manager the **pre-flight budget gate**, and makes one thing a hard contract requirement: the budget check must be **atomic** against the budget record, never read-then-decide. Otherwise §4's known race — two parallel runs both pass the check and together exceed the cap — is unhandled by construction. No budget gate exists today.

## What the finished component looks like

- [ ] A run refused because it would exceed a per-run or period cap, with the refusal visible to the user (§9).
- [ ] Two runs dispatched simultaneously against a cap that only one fits under: exactly one starts, proven by a concurrent test, not by reasoning.
- [ ] Idempotent replay still returns a no-op after the gate is added.

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md).

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
