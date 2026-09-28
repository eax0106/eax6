# C27 Localization

**Layer** platform · **Plane** platform, as received · **Category** 5 — not assessable yet

> Nothing has called this. It is neither known-good nor known-broken, and it has not earned a
> category. **Never let "not assessed" collapse into "works."**

## What it is

Language and locale handling across the product.

## Blast radius and fail mode

| | |
|---|---|
| Blast radius | `nothing` |
| Fail mode | `fail-closed` |

*No contract covers this component: added after the 54 contracts. These values stay proposed (task C13).*

## Where the code lives

- `apps/platform-api/src/i18n`
- `apps/platform-web/src/i18n`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

**Classified from source, not observed.**

## Design-log alignment — `SILENT`

Not specifically covered by the design log.

## What the finished component looks like

- [ ] Called live once, and only then assigned a category.
- [ ] **Never let "not assessed" collapse into "works"** — of three components previously counted as working on a source read alone, one worked, one failed its first request, and one had no surface to call.

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md).

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
