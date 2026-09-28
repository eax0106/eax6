# Planner

**Layer** L2 · **Plane** intelligence · **Category** 4 — build from scratch

> Either never implemented, or implemented in a shape that reproduces the flaw when ported.

## What it is

Chooses the execution strategy for a problem — single agent, manager-worker, and so on.

## Blast radius, fail mode and driver

**Contract 7 — Planner** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | this-layer-only. Design work stops; **and the `replan` recovery strategy becomes unavailable**, degrading self-heal without stopping runs that do not need it. |
| Fail mode | fail-closed. A partial or low-confidence decomposition must route to **8. Clarification Loop**, not proceed. |
| Driver | invoked by Problem Understanding for build/modify intents; invoked by Recovery Policy Engine when Classify selects `replan`. *Driver test:* both callers reach it — a fresh build produces a task skeleton, and a real failing run triggering `replan` also produces one. |

*From the contract (task C13, decision 0.7). The contract's done gates are targets, not gates that fail today.*

## Where the code lives

- `apps/intelligence-service/src/planner`
- `apps/intelligence-service/alter/planner`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

Selects strategy by counting words against a fixed keyword set, **never calling a model**. A padded trivial lookup escalates to manager-worker; a real three-team, twelve-country migration stated in 28 words does not. **The classification is inverted relative to actual scope.**

## Design-log alignment — `NEEDS-LOGIC`

Design log §1 names this defect in the old build **by name** — *"keyword-matched tier inference"* — as evidence that the reasoning underneath Alter's differentiator was still shallow. §3 requires reasoning to come from pretrained frontier models through a swappable gateway.

§24 is what makes the rewrite safe to schedule late: L6 is the strongest layer in the system and **what it consumes is a plan, not the Planner**. The design path runs once; the run path never touches this component.

The action plan's shape for the rewrite: a model call behind the same contract, **keeping the keyword path as a fallback for provider outages**.

## What the finished component looks like

- [ ] The planner golden set passes its floor of **0.90**, measured by the harness against a real provider.
- [ ] Keyword path retained as an outage fallback, not deleted.
- [ ] The golden set written before the rewrite.

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md).

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
