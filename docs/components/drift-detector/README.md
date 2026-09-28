# Drift Detector

**Layer** L8 · **Plane** memory · **Category** 3 — needs fixes or missing methods

> Both ends exist and the call is made, and something along the path is wrong. A source read marks
> these as finished, because from the source both halves look complete.

## What it is

Watches live performance and decays stale policy scores, so the engine's judgment tracks reality rather than a snapshot.

## Blast radius, fail mode and driver

**Contract 34 — Drift Detector** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | degraded (self only). Policy quality slowly decays and suggestions stop; nothing immediate breaks. |
| Fail mode | fail-open with loud logging. It must never block runs — but silent failure means learning quietly rots, which is exactly how the old build's drift detector ran under-scoped unnoticed. |
| Driver | **a real scheduler, mandatory.** *Driver test:* drift evaluation runs on schedule with no human involvement, and a genuine regression produces both a policy decay and a user-visible suggestion. |

*From the contract (task C13, decision 0.7). The contract's done gates are targets, not gates that fail today.*

## Where the code lives

- `apps/memory-service/src/drift`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

Scores compute and persist correctly. **The `drift_read` policy admits only model and provider subjects, so agent drift returns zero rows to its own tenant.** Computed, stored, consumed by nothing.

## Design-log alignment — `NEEDS-LOGIC`

Design log §17 gives this component a **second consumer**: an outbound suggestion path to the user, on top of its existing inward path to the Policy Store. That is how proactive improvement works, and §17 is emphatic about its shape — **Alter surfaces the suggestion with its reasoning; the user decides. It never silently edits a working workflow.**

The asymmetry against self-heal is deliberate: self-heal fires when something is *already broken*, where doing nothing is worse. Proactive improvement touches a workflow that is currently working fine, and silently editing something that works is a higher risk class.

What it can notice: a node consistently succeeding on a heavier model tier than the task needs; two nodes always running in sequence with no real data dependency, so they could run in parallel; the same failure being auto-healed the same way repeatedly, indicating the design should change rather than being patched every time.

Neither of its two paths is reachable today.

## What the finished component looks like

- [ ] `drift_read` admits the agent subject; scores are readable by the tenant that owns them.
- [ ] An outbound suggestion path to the user exists (§17).
- [ ] A drift score demonstrably changes the next selection — part of Phase 2's circuit.

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md).

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
