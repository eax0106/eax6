# auth package

**Layer** package · **Plane** packages · **Category** 5 — not assessable yet

> Nothing has called this. It is neither known-good nor known-broken, and it has not earned a
> category. **Never let "not assessed" collapse into "works."**

## What it is

Shared authentication primitives — token validation, scheme handling.

## Blast radius, fail mode and driver

**Contract 1 — Identity & Tenant Gateway** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | whole-engine. Legitimately so: if this is unavailable, nothing works. One of very few components permitted this rating. |
| Fail mode | fail-closed, absolutely. Deny whenever identity or permissions cannot be established. |
| Driver | invoked per-request by Platform API/BFF; invoked per-trigger-fire by Event & Trigger Gateway. *Driver test:* a real request travels end-to-end through both guards and arrives downstream with a non-empty permission set. |

*From the contract (task C13, decision 0.7). The contract's done gates are targets, not gates that fail today.*

## Where the code lives

- `packages/auth`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

**Libraries with unit tests rather than services with edges to misconfigure — the least worrying entries in this category.** Exercised transitively by everything in Category 1.

## Design-log alignment — `NEEDS-LOGIC`

Design log §7 pattern 4 is aimed squarely at packages like these: *duplicated primitives drifting apart — two ID validators, empty stub packages — single source of truth per shared primitive, enforced.* The old build shipped exactly that defect. The Cost Ledger's two tenant-ID formats are a live instance today, which is a `tenancy` concern as much as a Cost Ledger one. §26's rename (Identity & Tenant Gateway, Workspace & Workflow Management) is binding across code as well as documents.

## What the finished component looks like

- [ ] One definition per shared primitive, enforced by a gate rather than by discipline (task C1).
- [ ] No empty stub package survives.

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md).

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
