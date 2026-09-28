# Durable Substrate

**Layer** L6 · **Plane** temporal · **Category** 1 — works end to end

> **Do not change this component's logic or code during revival.** It is one of the 25 verified
> end to end on 4–6 September 2026, and it is the only verified value in the system. Anything
> necessary is recorded in [`memoryalter.md`](../../memoryalter.md) *before* it is made.

## What it is

Temporal. Provides the durable execution guarantees the whole run path rests on: a workflow survives process death and resumes where it stopped.

## Blast radius, fail mode and driver

**Contract 19 — Durable Substrate (Temporal — external managed service)** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | **whole-engine for the run path.** Genuinely: nothing executes, nothing recovers, nothing resumes. One of very few components warranting this rating. |
| Fail mode | fail-closed. Never fabricate durable state or proceed as though a checkpoint was written. |
| Driver | external service, driven by its own workers. *Driver test:* a run survives a process kill mid-execution and resumes correctly from durable state. |

*From the contract (task C13, decision 0.7). The contract's done gates are targets, not gates that fail today.*

## Where the code lives

- `apps/background-workers/src/executor`
- `docker-compose.yml`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

Every run appears as an `executorWorkflow` and closes `COMPLETED` carrying the node's output.

## Design-log alignment — `ALIGNED`

Locked in design log §7's architecture baseline. The caveat is not correctness but environment — see the done gate.

## What the finished component looks like

- [ ] Task 6.2: local Temporal is `start-dev`, a single process with no persistence guarantees. Moving to Temporal Cloud or a real cluster changes retention, history size limits and worker versioning — all of which the executor workflow currently assumes are generous. Not finished until it runs against a real cluster.

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md).

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
