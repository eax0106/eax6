# Verification & Quality Gate

**Layer** L8 · **Plane** verification · **Category** 1 — works end to end

> **Do not change this component's logic or code during revival.** It is one of the 25 verified
> end to end on 4–6 September 2026, and it is the only verified value in the system. Anything
> necessary is recorded in [`memoryalter.md`](../../memoryalter.md) *before* it is made.

## What it is

Judges whether a node's output actually did what it was supposed to. The component the entire verified-run billing claim rests on.

## Blast radius, fail mode and driver

**Contract 29 — Verification & Quality Gate** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | this-layer-only, severe. Under fail-closed rules nothing can be marked successful, so runs stall or fail rather than completing unverified. |
| Fail mode | **fail-closed, absolutely.** If verification errors, times out, or cannot get a clean signal, the result is unverified — routed to review, never silently counted as success. Section 5's honest framing: not "100% certain," but "never wrongly claims success it did not check." |
| Driver | invoked by Executor per node and at completion. *Driver test:* every node in a real run is verified; none is skipped. |

*From the contract (task C13, decision 0.7). The contract's done gates are targets, not gates that fail today.*

## Where the code lives

- `apps/verification-service/src/verification`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

Both paths real. A promoted tenant policy moved the threshold 0.7 to 0.95 on the next call, flipping identical output from pass to warn.

## Design-log alignment — `NEEDS-LOGIC`

Design log §5 specifies **three things that are not evidenced anywhere in the assessment**:

- **§5.1 intake requirement.** Before any workflow runs, a structured statement of what success looks like must be captured from the user. Every later check is judged against it.
- **§5.2 mechanical check.** Confirm the real external system reflects the claimed action — read the Slack channel back, read the sheet back. *Never trust "the API call returned success" alone.* This is the exact class of bug that broke the old build's workflow builder.
- **§5.3 end-of-run holistic check.** Even after every node passes individually, compare the combined outcome against the original success criteria.

The current gate judges nodes against their own sub-tasks — that is §5.3's semantic half only. **Absence of the other three is inferred, not established** (task C12): nobody looked for them. Check before scheduling; if genuinely missing this is a subsystem, not a patch.

§5.4 reviewer isolation is also required — output being judged is passed as clearly-marked data, never as an instruction the reviewer could act on. That closes the old build's audited confused-deputy flaw.

## What the finished component looks like

- [ ] Structured success criteria captured at intake and stored (§5.1).
- [ ] Mechanical read-back after every node that touches an external system (§5.2).
- [ ] End-of-run holistic check against those criteria (§5.3).
- [ ] Reviewer isolation proven with a hostile output that tries to instruct its own reviewer (§5.4).
- [ ] Fail-closed on timeout or error: counted as unverified, never as success (§5.5).

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md).

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
