# Durable Run Queue

**Layer** L6 · **Plane** orchestration · **Category** 1 — works end to end

> **Do not change this component's logic or code during revival.** It is one of the 25 verified
> end to end on 4–6 September 2026, and it is the only verified value in the system. Anything
> necessary is recorded in [`memoryalter.md`](../../memoryalter.md) *before* it is made.

## What it is

Holds queued runs durably between dispatch and pickup, with leases so a worker crash does not strand work, and a dead-letter path for runs that fail repeatedly.

## Blast radius, fail mode and driver

**Contract 17 — Durable Run Queue** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | this-layer-only, severe. No runs can be queued or dispatched. |
| Fail mode | fail-closed. Never acknowledge an entry whose work was not confirmed complete or terminally failed. |
| Driver | driven by Run Manager's sweeper (see contract 16). This component deliberately has no internal timer; that design is correct **provided a real caller drives it**, which is precisely what the old build lacked. |

*From the contract (task C13, decision 0.7). The contract's done gates are targets, not gates that fail today.*

## Where the code lives

- `apps/orchestration-service/src/runs`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

Drained to zero rows across nine dispatches, no stuck leases. Dead-letter cap of five confirmed in source and its regression test, **not by forcing live failures**.

## Design-log alignment — `ALIGNED`

No design-log requirement this component fails.

## What the finished component looks like

- [ ] The dead-letter cap proven by forcing five real consecutive failures, not by reading the constant.
- [ ] A killed worker mid-lease leaves no stranded row.

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md).

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
