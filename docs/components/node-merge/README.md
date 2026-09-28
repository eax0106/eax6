# Merge node type

**Layer** L6 · **Plane** node type · **Category** 1 — works end to end

> **Do not change this component's logic or code during revival.** It is one of the 25 verified
> end to end on 4–6 September 2026, and it is the only verified value in the system. Anything
> necessary is recorded in [`memoryalter.md`](../../memoryalter.md) *before* it is made.

## What it is

Converges parallel branches back into one path after a fan-out.

## Blast radius, fail mode and driver

**Contract 20 — Node Type Registry** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | this-layer-only. Executor cannot dispatch without it. |
| Fail mode | fail-closed. An unrecognized node kind must refuse to execute, never fall through to a default behavior. |
| Driver | invoked by Executor per node dispatch. *Driver test:* every registered node kind is reachable and correctly dispatched by a real workflow execution. |

*From the contract (task C13, decision 0.7). The contract's done gates are targets, not gates that fail today.*

## Where the code lives

- `apps/orchestration-service/src/registry`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

Converged the diamond and, critically, **completed without waiting for the branch the Gate had deactivated** — the deadlock every fan-out/fan-in design risks.

## Design-log alignment — `ALIGNED`

No design-log requirement this component fails.

## What the finished component looks like

Nothing outstanding. This component meets every requirement the design log places on it, and the assessment exercised it live. Its definition of done is that current behaviour holds.

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md).

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
