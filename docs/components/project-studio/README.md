# C7 Project Studio

**Layer** platform · **Plane** platform, as received · **Category** 3 — needs fixes or missing methods

> Both ends exist and the call is made, and something along the path is wrong. A source read marks
> these as finished, because from the source both halves look complete.

## What it is

Listing and opening projects.

## Blast radius and fail mode

| | |
|---|---|
| Blast radius | `nothing` |
| Fail mode | `fail-closed` |

*No contract covers this component: Project mode, added after the 54 contracts. These values stay proposed (task C13).*

## Where the code lives

- `apps/platform-web/src/features/projects`
- `apps/orchestration-service/src/project-read`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

Every route is `projects/:projectId/…`; **there is no `GET /projects` and no `GET /projects/:id`** — confirmed in source. List and detail have nothing to call.

## Design-log alignment — `ALIGNED`

Additive and safe. Note design log §23 defers Project Mode to a later version — this surface is workflow projects, not built-and-deployed software.

## What the finished component looks like

- [ ] The surface issues real requests against real routes.
- [ ] No control reports success without a call behind it.

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md) — task **B4**.

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
