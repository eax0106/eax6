# Audit Ledger

**Layer** L8 · **Plane** audit-service · **Category** 1 — works end to end

> **Do not change this component's logic or code during revival.** It is one of the 25 verified
> end to end on 4–6 September 2026, and it is the only verified value in the system. Anything
> necessary is recorded in [`memoryalter.md`](../../memoryalter.md) *before* it is made.

## What it is

The tamper-evident record of what happened, hash-chained so a forgery is detectable.

## Blast radius, fail mode and driver

**Contract 38 — Audit** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | degraded (self only) for writes. **But an audit gap is a compliance gap**, so write failures must be loud. |
| Fail mode | fail-open for writes with loud alerting (never block a run), fail-closed for verification (never report a chain valid that was not checked). |
| Driver | writes driven by every component. **Chain verification requires a scheduler**, with alerting on any non-valid result. The read path must be incremental before it can run on a schedule. *Driver test:* chain verification runs on schedule, unprompted, and a deliberately tampered entry raises an alert. |

*From the contract (task C13, decision 0.7). The contract's done gates are targets, not gates that fail today.*

## Where the code lives

- `apps/audit-service/src/audit`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

**The most strongly defended component probed so far.** Six events recorded, queried back and chain-verified. Then attacked: an `UPDATE` as the service role was refused with `audit_events is immutable`, from a PL/pgSQL trigger; `DELETE` the same; **the same refusal held as superuser**. Row-level security additionally returns zero rows to the service's own role until `app.audit_internal` is explicitly set. Only by disabling the trigger could a row be forged, and the full chain walk then caught it and named the entry:

```
{"valid":false,"issue":"hash-mismatch","eventId":"aud_01a07580-c3e9-…"}
```

One structural note, safe today only because of the trigger: incremental verify resumes from a checkpoint, **so a forgery in already-checkpointed history is never re-examined**, and the full-walk `verifyChain()` that does catch it has no route and no caller.

## Design-log alignment — `NEEDS-LOGIC`

`verifyChain()` with no caller is design log **§7 pattern 3 verbatim**: real machinery with nothing driving it. The prescribed fix is a mandatory driver-exists test for every scheduled or background component, not just proof the mechanism works when called. §18 additionally requires audit minimization on owner account deletion — event skeleton only, held for a defined window, then genuinely destroyed — and the reason matters: if account deletion erases the log outright, the person with the strongest motive to destroy it is the one holding the button.

## Decision — 2026-09-08 · design log §30

**Every service-asserted tenant is audited.** Decision 0.1 lets an internal caller assert which tenant it is acting for, guarded by a shared service credential. That credential is the weak point, and the audit trail is what makes a leak recoverable rather than unbounded.

New requirement on this component: internal calls that carry an asserted tenant produce an audit event naming the asserting service and the tenant asserted.

Rationale: [`phase-0-decisions.md` §0.1](../../phase-0-decisions.md).

## What the finished component looks like

- [ ] `verifyChain()` has a route and a schedule, even if only weekly (task 6.4).
- [ ] A driver-exists test that fails if the schedule is ever removed.
- [ ] §18 audit minimization implemented for owner account deletion.

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md).

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
