# C24 Platform Jobs

**Layer** platform · **Plane** platform, as received · **Category** 5 — not assessable yet

> Nothing has called this. It is neither known-good nor known-broken, and it has not earned a
> category. **Never let "not assessed" collapse into "works."**

## What it is

Scheduled and background work on the platform side.

## Blast radius and fail mode

| | |
|---|---|
| Blast radius | `nothing` |
| Fail mode | `fail-closed` |

*No contract covers this component: scheduled platform jobs, added after the 54 contracts. These values stay proposed (task C13).*

## Where the code lives

- `apps/background-workers/src/platform-jobs`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

**Classified from source, not observed.** Design log §7 pattern 3 applies directly: every scheduled component needs a **driver-exists test**, not just proof the mechanism works when called.

## Design-log alignment — `SILENT`

Not specifically covered by the design log. Design log §7 pattern 3 applies directly: every scheduled component needs a **driver-exists test**, not just proof the mechanism works when called.

## What the finished component looks like

- [ ] Called live once, and only then assigned a category.
- [ ] **Never let "not assessed" collapse into "works"** — of three components previously counted as working on a source read alone, one worked, one failed its first request, and one had no surface to call.

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md).

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
