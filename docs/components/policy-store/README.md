# Policy Store

**Layer** L8 · **Plane** memory · **Category** 1 — works end to end

> **Do not change this component's logic or code during revival.** It is one of the 25 verified
> end to end on 4–6 September 2026, and it is the only verified value in the system. Anything
> necessary is recorded in [`memoryalter.md`](../../memoryalter.md) *before* it is made.

## What it is

The engine's learning, stored as versioned symbolic policy rather than a neural net: routing weights, quality thresholds, recovery preferences, pattern scores — explainable, inspectable, reversible.

## Blast radius, fail mode and driver

**Contract 33 — Policy Store** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | this-layer-only. Consumers must degrade visibly rather than silently reverting to defaults. |
| Fail mode | fail-closed. Optimistic-concurrency conflicts must be surfaced, never silently overwritten. |
| Driver | read by its consumers; written by Memory & Learning and Drift Detector. *Driver test:* a policy change measurably alters a real routing decision, and rolling it back restores the prior behavior. |

*From the contract (task C13, decision 0.7). The contract's done gates are targets, not gates that fail today.*

## Where the code lives

- `apps/memory-service/src/policy_store`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

Full draft to canary to active lifecycle. Three declared kinds writable, a fourth correctly rejected.

## Design-log alignment — `NEEDS-LOGIC`

Design log §22 requires **two scopes: tenant-local and global**. The global tier carries cross-tenant abstracted learning approved in §2, and **must be structurally incapable of holding tenant-specific content** — enforced by schema and by what the write path physically accepts, so a mistake fails loudly rather than silently leaking one customer's specifics into every tenant's policy. Same reasoning as §18's schema-derived deletion: a hand-maintained discipline against a growing system drifts eventually. The global tier does not exist yet, so the constraint costs nothing to add now.

## What the finished component looks like

- [ ] A global tier exists and the write path physically rejects tenant-specific content.
- [ ] §18: expiring run history does not degrade learning — distilled lessons live here, separately from raw run records.

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md).

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
