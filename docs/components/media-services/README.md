# C20 Media Services

**Layer** platform-web · **Plane** platform, as received · **Category** 2 — needs wiring only

> Both ends exist and answer. This is wiring, not repair — the cheapest class of work on the board.

## What it is

Media upload, storage and retrieval for the product surface.

## Blast radius and fail mode

| | |
|---|---|
| Blast radius | `nothing` |
| Fail mode | `fail-closed` |

*No contract covers this component: added after the 54 contracts. These values stay proposed (task C13).*

## Where the code lives

- `apps/platform-api/src/media`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

Source read only — **not observed live.** Confirm before counting it.

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
