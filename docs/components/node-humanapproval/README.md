# HumanApproval node type

**Layer** L6 · **Plane** node type · **Category** 1 — works end to end

> **Do not change this component's logic or code during revival.** It is one of the 25 verified
> end to end on 4–6 September 2026, and it is the only verified value in the system. Anything
> necessary is recorded in [`memoryalter.md`](../../memoryalter.md) *before* it is made.

## What it is

Pauses a run durably until a permitted human decides, then resumes it. The pause and resume are the entire point of the node type.

## Blast radius, fail mode and driver

**Contract 20 — Node Type Registry** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | this-layer-only. Executor cannot dispatch without it. |
| Fail mode | fail-closed. An unrecognized node kind must refuse to execute, never fall through to a default behavior. |
| Driver | invoked by Executor per node dispatch. *Driver test:* every registered node kind is reachable and correctly dispatched by a real workflow execution. |

**Contract 25 — Approval Store** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | this-layer-only. Workflows containing approval nodes block at those nodes; others are unaffected. |
| Fail mode | fail-closed. Never auto-approve because state could not be read. Never lose a decision that a human actually made. |
| Driver | raised by Executor; decided by humans via Platform API; **timeout mode needs its own driver** — a real scheduler for auto-reject-on-timeout. *Driver test:* a timeout-mode approval actually times out and resolves without anyone touching the system. |

*From the contract (task C13, decision 0.7). The contract's done gates are targets, not gates that fail today.*

## Where the code lives

- `apps/orchestration-service/src/approvals`
- `apps/platform-api/src/action-centre`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

Paused the run durably, held it, then resumed on the `approvalDecided` signal and completed. **The human-facing REST route that should send that signal is not verified** — it needs a properly minted delegation token, the same boundary the platform run had to reconcile.

## Design-log alignment — `NEEDS-LOGIC`

Design log §16 specifies **four configurable modes** — always block, auto-approve (still recorded as auto-approved by policy so the audit trail stays complete), auto-reject/skip on timeout, and approve-once-always-allow with promotion that is suggested and human-confirmed, never silent. None of that is evidenced. §22 item 8 additionally makes the engine the owner of the durable decision record, with the inbox as a Platform read model.

## What the finished component looks like

- [ ] All four §16 modes configurable per node.
- [ ] Promotion suggested by Alter and confirmed by a human — never applied silently.
- [ ] The human-facing REST route exercised end to end with a real delegation token (task 6.3).

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md).

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
