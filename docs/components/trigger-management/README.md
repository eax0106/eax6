# C13 Trigger Management

**Layer** platform · **Plane** platform, as received · **Category** 3 — needs fixes or missing methods

> Both ends exist and the call is made, and something along the path is wrong. A source read marks
> these as finished, because from the source both halves look complete.

## What it is

Creating, testing and removing the triggers that start workflows.

## Blast radius, fail mode and driver

**Contract 2 — Event & Trigger Gateway** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | this-layer-only. If it is down, new external work cannot enter the engine, but in-flight runs continue unaffected. |
| Fail mode | fail-closed. Reject signals that fail validation, signature verification, or durable write. Never accept-and-hope. |
| Driver | external callers drive the webhook and form paths. **Scheduled triggers need their own driver** — a real scheduler, not an incidental one. *Driver test:* a scheduled trigger fires on time with no other activity in the system. This is precisely the old build's Pattern 3 failure (a dispatch queue whose only driver was the next unrelated launch); the test must prove the scheduler exists and runs unprompted. |

*From the contract (task C13, decision 0.7). The contract's done gates are targets, not gates that fail today.*

## Where the code lives

- `apps/platform-web/src/features/triggers`
- `apps/orchestration-service/src/trigger-registry`
- `apps/orchestration-service/src/trigger-bindings`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

Reads are live; **`testTrigger` and `removeTrigger` report success without calling anything.**

## Design-log alignment — `CONFLICT`

Design log §5.5 fail-closed and §7 pattern 1 both forbid this outright: a result is *never silently counted as success*, and an unmarked stub on a production path must fail a CI gate. **A control that claims to have deleted something and has not is worse than one that does nothing visible** — prioritise above cosmetic items. §8 also makes the trigger just another node the user can hand-wire on canvas, with Alter building it conversationally by default.

## What the finished component looks like

- [ ] The surface issues real requests against real routes.
- [ ] No control reports success without a call behind it.

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md) — task **B5**.

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
