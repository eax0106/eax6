# C6 Human Action Centre

**Layer** platform · **Plane** platform, as received · **Category** 3 — needs fixes or missing methods

> Both ends exist and the call is made, and something along the path is wrong. A source read marks
> these as finished, because from the source both halves look complete.

## What it is

"What is waiting on me" across every workflow — the approval inbox.

## Blast radius, fail mode and driver

**Contract 53 — Approval Inbox** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | degraded (self only), but approvals block their runs while unseen. |
| Fail mode | fail-closed. Never display an approval as decided that was not, and never lose a submitted decision. |
| Driver | user interaction; **arrival driven by 45. Notification**. *Driver test:* an approval raised during an unattended run appears here and is actionable. |

**Contract 25 — Approval Store** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | this-layer-only. Workflows containing approval nodes block at those nodes; others are unaffected. |
| Fail mode | fail-closed. Never auto-approve because state could not be read. Never lose a decision that a human actually made. |
| Driver | raised by Executor; decided by humans via Platform API; **timeout mode needs its own driver** — a real scheduler for auto-reject-on-timeout. *Driver test:* a timeout-mode approval actually times out and resolves without anyone touching the system. |

*From the contract (task C13, decision 0.7). The contract's done gates are targets, not gates that fail today.*

## Where the code lives

- `apps/platform-web/src/features/human-actions`
- `apps/platform-api/src/action-centre`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

The UI sends `status=open`; the API accepts `pending·approved·rejected·expired`. **Only `expired` overlaps.**

## Design-log alignment — `CONFLICT`

**Settled.** Design log §22 item 8 makes this inbox a **Platform-side read model** built on the engine's durable approval decision record — the engine holds the record because it is execution evidence feeding the audit chain and §16's promotion logic. A read model maps onto its source, never the reverse. **The engine's enum is canonical; the platform moves.** Recorded as decision 0.5. §27 also names Approval Inbox one of the five surfaces, and notes it cannot exist before the approval record does — it does.

## Decision — 2026-09-08 · design log §22 item 8

**The engine's enum is canonical** (`pending·approved·rejected·expired`). **The platform moves.**

The approval inbox is a Platform-side read model built on top of the engine's durable decision record. The engine holds that record because it is execution evidence feeding the audit chain and §16's promotion logic. A read model maps onto its source, never the reverse.

Rationale: [`phase-0-decisions.md` §0.5](../../phase-0-decisions.md). Implementation is task B-vocab.

## What the finished component looks like

- [ ] The surface issues real requests against real routes.
- [ ] No control reports success without a call behind it.

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md) — task **B-vocab**.

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
