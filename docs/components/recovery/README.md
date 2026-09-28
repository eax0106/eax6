# Recovery

**Layer** L8 · **Plane** orchestration · **Category** 3 — needs fixes or missing methods

> Both ends exist and the call is made, and something along the path is wrong. A source read marks
> these as finished, because from the source both halves look complete.

## What it is

The self-heal engine. Classifies why a node failed, selects a strategy, and dispatches it — keeping the workflow alive without a blocking human gate.

## Blast radius, fail mode and driver

**Contract 30 — Recovery Policy Engine** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | this-layer-only. Failures cannot be repaired; runs fail rather than self-healing. |
| Fail mode | fail-closed. An unclassifiable failure escalates to the user rather than defaulting to a guessed strategy. |
| Driver | invoked by Verification and Executor on failure. *Driver test:* a real failure of each classified type produces the correct strategy and a real repair. |

*From the contract (task C13, decision 0.7). The contract's done gates are targets, not gates that fail today.*

## Where the code lives

- `apps/orchestration-service/src/recovery`
- `apps/orchestration-service/src/escalations`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

**`replan` and `recompile` send a `CompiledDag` where the planner validates a `TaskSkeleton`. Two of eight dispatchable strategies are dead.** `repair` decides correctly and then defers — an omission, not a boundary.

## Design-log alignment — `CONFLICT`

**The contract question is answered.** Design log §24: Recovery's `replan`/`recompile` *"jumps from the run path back into the **design path**"*. The design path is L1→L5 and L5 is what produces the DAG, so re-entering it means entering **above** the compiler — `TaskSkeleton` is canonical. The current code sends the run path's output back as the design path's input, inverting the crossing. Recorded as decision 0.2.

§4 specifies the rest of this component in detail, and most of it is unevidenced:

- **Internal stages, in order: Classify, Select Strategy, Dispatch.** Classification is *mandatory before self-heal fires*. The old build had no classification stage at all, so a transient database error was treated as terminal and permanently dropped a run a plain retry would have fixed.
- **Five classify buckets** — transient/environmental (one plain retry); node's-own-fault (instant self-heal, no wasted retry); credential gap (hard stop, no self-heal — swapping the agent does not fix a missing credential, and OAuth requires a human to click allow); target resource/state mismatch (ask the user to redirect); genuinely ambiguous (route **only** to the Clarification Loop, never retry or swap).
- **Two things that look like buckets and are not.** Policy/limit blocks are a pre-flight gate, not a post-failure classification. **Safety violations must halt the whole workflow immediately, before Recovery is ever invoked** — Recovery's job is to keep going, which is the wrong instinct against an attack path.
- **The idempotency gate sits in front of Dispatch for every bucket that re-executes**, backed by a Side-Effect Ledger (§22 item 7) that does not exist. Without it, Recovery retrying a partially-completed workflow re-fires completed steps — sends the message twice, writes the row twice — and the recovery system becomes the thing that breaks the run.

The bucket list is flagged in §29 as provisional: expect refinement once real testing surfaces failure modes not yet imagined.

## Decision — 2026-09-08 · design log §24

**`TaskSkeleton` is canonical** for `replan` and `recompile`, not `CompiledDag`.

Recovery's replan *"jumps from the run path back into the design path."* The design path is L1→L5, and L5 (Graph Compiler) is what **produces** the DAG. Re-entering the design path means entering **above** the compiler, so replan hands back what that path consumes, not what it emits. The current code sends the run path's output back as the design path's input, inverting the crossing.

Revives two of eight dispatchable strategies. Implementation is task 2.2.

Rationale: [`phase-0-decisions.md` §0.2](../../phase-0-decisions.md).

## What the finished component looks like

- [ ] `replan` and `recompile` send `TaskSkeleton`; both strategies live again.
- [ ] `repair` finishes rather than defers.
- [ ] A Classify stage exists with the five buckets, and a transient error takes one plain retry rather than dropping the run.
- [ ] Safety violations halt before Recovery is invoked, not inside it.
- [ ] The idempotency gate passes in front of every re-executing Dispatch.
- [ ] **Phase 2 acceptance:** a forced failure reaches Recovery, replans, summarises into Memory, and moves a Drift score that changes the next selection. Anything less is not this phase finished.

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md).

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
