# C17 Notifications

**Layer** platform-web · **Plane** platform, as received · **Category** 2 — needs wiring only

> Both ends exist and answer. This is wiring, not repair — the cheapest class of work on the board.

## What it is

Delivery of everything the engine needs a human to see: self-heal notify-after, pending approvals, proactive suggestions.

## Blast radius, fail mode and driver

**Contract 45 — Notification** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | this-layer-only. Runs continue, but **humans stop learning that they are needed** — pending approvals go unseen, self-heals unreviewed, suggestions unnoticed. |
| Fail mode | fail-closed on delivery confirmation. An undelivered notification must be retried and surfaced, never silently dropped — the failure mode that makes an approval gate meaningless. |
| Driver | invoked by its five senders. **Retry of undelivered notifications needs its own driver.** *Driver test:* an approval raised during an unattended run genuinely reaches a person. |

*From the contract (task C13, decision 0.7). The contract's done gates are targets, not gates that fail today.*

## Where the code lives

- `apps/platform-api/src/notifications`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

Seven methods, none wired.

## Design-log alignment — `ALIGNED`

Design log §6 and §27 say this category should not exist: *UI must never get ahead of real backend wiring* — that is what produced the old build's fake workflow canvas — and each of §27's five surfaces appears only as the backend it exercises becomes real. Remediation, however, is pure wiring: both ends exist and answer.

## What the finished component looks like

- [ ] The screen issues real requests against the answering route.
- [ ] No control reports success without a call behind it.
- [ ] Permissions enforced end to end, not just at the route.

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md) — task **B3**.

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
