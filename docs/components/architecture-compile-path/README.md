# Architecture compile path

**Layer** L5 · **Plane** orchestration · **Category** 1 — works end to end

> **Do not change this component's logic or code during revival.** It is one of the 25 verified
> end to end on 4–6 September 2026, and it is the only verified value in the system. Anything
> necessary is recorded in [`memoryalter.md`](../../memoryalter.md) *before* it is made.

## What it is

The second route into the Graph Compiler: lowers a synthesized architecture into an executable DAG, rather than compiling from a task skeleton.

## Blast radius, fail mode and driver

**Contract 10 — Architecture Synthesizer** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | degraded (self only). Design path only; existing workflows are unaffected. |
| Fail mode | fail-closed. A low-confidence architecture must ask rather than ship a guessed topology — a wrong topology produces a workflow that runs successfully while doing the wrong thing, which verification may not catch. |
| Driver | invoked by Capability Resolver in the design chain. *Driver test:* a real ProblemSpec traverses Planner → Resolver → Synthesizer and produces a complete ArchitectureSpec. |

**Contract 14 — Graph Compiler** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | this-layer-only. Already-compiled workflows keep running; new compilation and recompile-class recovery stop. |
| Fail mode | fail-closed. An invalid DAG must never compile — a graph that fails validation cannot be stored or executed under any circumstance. |
| Driver | invoked by Selection & Binding on the design path; by Recovery for recompile/replan; by Canvas for manual-edit validation (design log Section 8's impact analysis reuses this validator rather than duplicating it). *Driver test:* all three callers compile or validate through this one component, and no fourth path exists. |

*From the contract (task C13, decision 0.7). The contract's done gates are targets, not gates that fail today.*

## Where the code lives

- `apps/orchestration-service/src/compiler`
- `apps/intelligence-service/src/architecture_synthesizer`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

Fixed in #116 and then run. The Synthesizer was dropping each node's config on the floor, so every DAG this path produced had nothing to execute. Both halves now carry it: synthesis returned two nodes holding their `model_alias` and `prompt`, `CompileArchitectureWorkflow` lowered them into a two-node DAG, and the run completed. **The counterfactual is the proof** — the same architecture with config stripped failed at the first node with `LLMTask requires a non-empty config.prompt string`, exactly what every architecture-path run hit before the fix.

## Design-log alignment — `NEEDS-LOGIC`

Still writes `node_requirements` as an empty object where the task-skeleton path resolves the real map (#117). Nothing reads that column at run time — both the Executor and Recovery resolve capabilities fresh — so it is latent rather than broken. It is a wrong answer waiting for its first reader: an audit view or a cost estimate would be told the workflow requires no capabilities at all.

## Decision — 2026-09-08 · design log §32

**The architecture path copies the requirements map the caller already supplied**, rather than re-resolving it.

Nearly free: `architecture_synthesizer/models.py:115` already validates `request.node_requirements` against the node keys, so the data is present at the call site and simply is not persisted.

**Recorded residual, so it is not lost.** Filling the column leaves two sources for one fact — the stored map, and the fresh resolution the Executor (`nodeexec.service.ts:386`) and Recovery (`recovery-dispatch.service.ts:343`) each perform at run time. That is design log §7 pattern 4, duplicated primitives drifting apart, arrived at from the other direction. The clean resolution is for run-time consumers to read the stored value, or for the column to be deleted as redundant — **deferred as task C14**, because it touches the Executor, which is frozen during revival.

Rationale and rejected alternatives: [`phase-0-decisions.md` §0.4](../../phase-0-decisions.md). Was issue #117 on the frozen `alter-x-4-` repo. Implementation is task 3.6.

## What the finished component looks like

- [ ] `node_requirements` carries a real map, per decision 0.4.

## Open issues

- [#117](https://github.com/havishalterx-eng/alter-x-4-/issues/117)

## Where this sits in the plan

See [`checklist.md`](../../checklist.md).

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
