# Capability Registry

**Layer** L3 · **Plane** intelligence · **Category** 1 — works end to end

> **Do not change this component's logic or code during revival.** It is one of the 25 verified
> end to end on 4–6 September 2026, and it is the only verified value in the system. Anything
> necessary is recorded in [`memoryalter.md`](../../memoryalter.md) *before* it is made.

## What it is

The catalogue of what agents can do, versioned and tenant-scoped.

## Blast radius, fail mode and driver

**Contract 11 — Capability Registry** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | this-layer-only. Compiled workflows keep running (bindings are already baked into the DAG), but new design work stops **and** the swap-agent / rebind recovery strategies become unavailable. |
| Fail mode | fail-closed. An incomplete candidate set must be reported as incomplete, never returned as if it were the full set — otherwise Selection & Binding silently picks from a truncated field. |
| Driver | lookups driven by Selection & Binding and by Recovery. **Availability and health metadata need their own driver** — a real scheduled refresh, not a manual switch. *Driver test:* a provider going unhealthy is reflected in registry availability without human intervention. *(The old build had a correct, properly-authorized provider-health failover switch that no automated signal ever fed — Pattern 3 exactly.)* |

*From the contract (task C13, decision 0.7). The contract's done gates are targets, not gates that fail today.*

## Where the code lives

- `apps/intelligence-service/src/capability_registry`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

Register, search, get-by-version and deactivate all behave; a search scoped to another tenant returns nothing.

## Design-log alignment — `NEEDS-LOGIC`

Design log §19 additionally requires this component to hold and retrieve **reusable workflow patterns and templates from day one**, because the first-run experience shows curated templates below the description box. Constraint locked alongside it: **templates are hand-authored, never harvested from real user workflows.** An abstract lesson carries no customer content; a template is a near-complete workflow shape — node structure, tool choices, sometimes prompt phrasing — and harvesting one customer's workflow into another's account is a different and higher risk class. If harvesting is ever wanted it needs its own explicit decision and privacy review.

## What the finished component looks like

- [ ] Curated templates stored and retrievable.
- [ ] Nothing in the template path can ingest a real tenant workflow.

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md).

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
