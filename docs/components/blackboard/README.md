# Blackboard

**Layer** L6 · **Plane** orchestration · **Category** 1 — works end to end

> **Do not change this component's logic or code during revival.** It is one of the 25 verified
> end to end on 4–6 September 2026, and it is the only verified value in the system. Anything
> necessary is recorded in [`memoryalter.md`](../../memoryalter.md) *before* it is made.

## What it is

Carries one node's output to the next during a run. Redis accelerates; Postgres decides.

## Blast radius, fail mode and driver

**Contract 22 — Blackboard** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | this-layer-only. Runs cannot share context between nodes. |
| Fail mode | fail-closed. Never return partial or stale context as though complete — a node reasoning on incomplete inherited context produces confidently wrong output. |
| Driver | written and read by Executor during execution. *Driver test:* a downstream node genuinely receives an upstream node's output through this component, with no re-prompting. |

*From the contract (task C13, decision 0.7). The contract's done gates are targets, not gates that fail today.*

## Where the code lives

- `apps/orchestration-service/src/blackboard`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

Write, read, `FLUSHALL`, read again — the value still returns. Since verified doing its actual job: carrying one node's output to the next, rather than only answering direct reads and writes.

## Design-log alignment — `ALIGNED`

Design log §22 item 7 explicitly rejected folding the Side-Effect Ledger into the Blackboard, because the old design warned against the Blackboard becoming long-term storage and side-effect records carry compliance weight that scratch context does not. Keep it scratch.

## What the finished component looks like

- [ ] Stays scratch. If anything long-lived starts accumulating here, that is a design regression.

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md).

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
