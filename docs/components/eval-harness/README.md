# Eval Harness

**Layer** L8 · **Plane** eval-service · **Category** 1 — works end to end

> **Do not change this component's logic or code during revival.** It is one of the 25 verified
> end to end on 4–6 September 2026, and it is the only verified value in the system. Anything
> necessary is recorded in [`memoryalter.md`](../../memoryalter.md) *before* it is made.

## What it is

Measures whether the engine is actually any good: golden sets, release gates, chaos scenarios, load suites. The instrument every quality claim depends on.

## Blast radius, fail mode and driver

**Contract 40 — Eval & Red-team** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | this-layer-only. Promotion halts (correctly) rather than proceeding unevaluated. |
| Fail mode | fail-closed, absolutely. Unevaluable means fail, never pass. |
| Driver | promotion gating driven by Workflow Lifecycle; **scheduled regression evaluation needs its own scheduler.** *Driver test:* the promotion gate blocks a real promotion that should fail, and scheduled evaluation runs unprompted. |

*From the contract (task C13, decision 0.7). The contract's done gates are targets, not gates that fail today.*

## Where the code lives

- `apps/eval-service/src/execution`
- `tests/load/k6`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

The last tier-2 service, and it now runs. All three RPCs answer. `RunEvaluation` executed a real 30-case golden set to completion and persisted a scored result for every case; `CheckReleaseGate` read that run back and returned NotFound for an unknown one; `RecordPromotionDecision` returned approved for a complete evidence bundle and blocked with the precise cause for each incomplete one (`metric_failed:intent:0.8>=0.95`, `missing_approval:ceo`), each with its own evidence digest. Unauthenticated calls are refused.

**The 30-case run scored 0 of 30, and that is the right answer rather than a broken harness**: every case recorded a specific reason, all of them the injection screen inside `ClassifyIntent` failing to reach ads-core, which was not running.

## Design-log alignment — `ALIGNED`

The 0/30 is design log §11 landing. The log rejected safety-as-a-standalone-service and named this exact failure mode: *safety checks fire constantly, so a network hop on every one turns that service into a new single point of failure every gateway depends on.* Thirty cases failing on one unreachable dependency is that prediction arriving.

## What the finished component looks like

- [ ] A 30-case golden set scores above zero **for a real reason** — the Phase 1 done gate.
- [ ] Planner and architecture golden sets written **before** the Phase 4 rewrites, so the target is fixed in advance rather than fitted afterwards.
- [ ] Chaos scenarios, load suites and the nine metric floors run against something real (task 6.5).

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md).

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
