# Synthesis

**Layer** L8 · **Plane** orchestration · **Category** 1 — works end to end

> **Do not change this component's logic or code during revival.** It is one of the 25 verified
> end to end on 4–6 September 2026, and it is the only verified value in the system. Anything
> necessary is recorded in [`memoryalter.md`](../../memoryalter.md) *before* it is made.

## What it is

Combines verified upstream outputs into a final result, degrading honestly when there is not enough to work with.

## Blast radius, fail mode and driver

**Contract 31 — Synthesis** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | this-layer-only. Runs execute but cannot deliver a final result. |
| Fail mode | fail-closed. Never present partial output as complete. |
| Driver | invoked by Executor when the graph completes or is degraded. *Driver test:* a completed run produces an assembled result; a degraded run produces a labeled partial one. |

*From the contract (task C13, decision 0.7). The contract's done gates are targets, not gates that fail today.*

## Where the code lives

- `apps/orchestration-service/src/registry`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

Reachable, and **declines honestly when there is nothing verified upstream to degrade into**.

## Design-log alignment — `ALIGNED`

Declining rather than inventing is exactly §5.5's fail-closed instinct applied at the synthesis step.

## What the finished component looks like

Nothing outstanding. This component meets every requirement the design log places on it, and the assessment exercised it live. Its definition of done is that current behaviour holds.

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md).

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
