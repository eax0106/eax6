# C9 Repository Manager

**Layer** platform · **Plane** platform, as received · **Category** 4 — build from scratch

> Either never implemented, or implemented in a shape that reproduces the flaw when ported.

## What it is

Declared surface for managing repositories. Nothing is known about its intended behaviour beyond the name.

## Blast radius and fail mode

| | |
|---|---|
| Blast radius | `nothing` |
| Fail mode | `fail-closed` |

*Proposed, not ratified.* Design log §29 lists per-component blast radius and fail mode as an open item — *"not yet applied to any specific component list."* These are a first pass, to be confirmed when the component's contract is written.

## Where the code lives

- `apps/platform-api/src/repositories`
- `apps/platform-web/src/features/settings/pages/repositories.tsx`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

**Declared, never implemented.** Unlike Deployment Manager, no backend contract exists to build against.

## Design-log alignment — `SILENT`

Not in the design log. **Needs a scope decision before an engineering one** (decision 0.6). Until it is explicitly cut or explicitly scoped it keeps appearing in counts as pending work and distorting every estimate that includes it.

## Decision — 2026-09-08 · design log §33 · **CUT FROM v1**

**Cut.** Declared, never implemented, and unlike Deployment Manager it has no backend contract to build against. Nobody has stated what it is for.

**Decided, not executed.** Cutting means removing or deprecating the declaration — a note is not a cut. Task 5.2 stays open until it is gone.

## Decision — 2026-09-28 · design log §33 amended · **BUILT, STANDALONE**

Havish reinstated it for v1 with a written purpose: link GitHub repositories through the workspace's own GitHub OAuth connection and read their branches and open pull requests. Code: `apps/platform-api/src/repositories`, migration `0021_repository_bindings`, `apps/platform-web/src/features/settings/pages/repositories.tsx`. Read-only against GitHub; bindings hold identifiers, never tokens. Creation, transfer and writes stay with Project Mode (out of v1, §23).

Note that **Deployment Manager is not cut**: its backend contract is real (`DeployctlService`, three RPCs) and only the surface is missing. It remains task 5.3.

Rationale: [`phase-0-decisions.md` §0.6](../../phase-0-decisions.md).

## What the finished component looks like

- [ ] Either ships, or is **explicitly cut** from the first release and its contract marked as such.

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md) — task **5.2**.

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
