# Agent Auto-Creation

**Layer** L4 · **Plane** intelligence · **Category** 3 — needs fixes or missing methods

> Both ends exist and the call is made, and something along the path is wrong. A source read marks
> these as finished, because from the source both halves look complete.

## What it is

Creates a brand-new agent when no existing one fits — on the design path when selection finds nothing, and on the run path during self-heal.

## Blast radius and fail mode

| | |
|---|---|
| Blast radius | `this-layer-only` |
| Fail mode | `fail-closed` |

*Proposed, not ratified.* Design log §29 lists per-component blast radius and fail mode as an open item — *"not yet applied to any specific component list."* These are a first pass, to be confirmed when the component's contract is written.

## Where the code lives

- `apps/intelligence-service/src/agent_auto_creation`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

Exercised for the first time, and it does create an agent — a draft row, a version carrying the requested alias and capability, a 512-dimension embedding, bound and returned in one call.

**It cannot satisfy the requirement that triggers it**: the insert hardcodes tier to `STANDARD` while eligibility filters on that same column, so an unmet tier requirement creates an agent that still fails it. **Three identical requests produced three different agents**, taking the tenant from five to eight. A retrying caller writes a row per attempt with nothing bounding it (#125). Provoking it at all required the tier filter, because the capability route cannot produce a no-match locally.

## Design-log alignment — `CONFLICT`

Design log §22 item 9 makes **Agent Factory its own L4 component**, reversing the old spec that folded it into Selection & Binding. The decisive reason: **it has two callers in different layers** — Selection & Binding on the design path, Recovery on the run path during self-heal. *A capability invoked by two different layers cannot live inside one of them without the other reaching sideways through it.* Secondary reasons: selection is search (score existing candidates) while creation is authoring (define role, write instructions, choose model and tools); and §1 names live agent creation one of only two genuinely unproven pieces in the product, so it warrants its own folder, spec and definition of done.

On the tier question, three options exist rather than the two the action plan lists. The plan's own read is **refuse above a ceiling — safer, and makes the failure visible.** Design log §9's pre-flight budget gate offers a third: create at the tier asked for, and bound abuse with spend caps rather than a tier ceiling.

## Decision — 2026-09-08 · design log §31

Two separable problems. Only one was ever a policy question.

**Idempotency is not a policy question and does not wait for anything.** Pulled out of Phase 0 entirely as task **3.0**, ahead of the tier work. Creation becomes idempotent per tenant, workspace and capability set. A retrying caller currently writes a permanent agent row per attempt, so every day this stays open adds rows nothing will clean up.

**On the tier: never create an agent that cannot satisfy the requirement that triggered its creation.** Hardcoding `STANDARD` while eligibility filters on that same column is a **correctness** defect, not a cost one — the failure surfaces several steps downstream where the cause is no longer recoverable.

- When the requested tier exceeds policy, **fail the bind with a named reason** rather than substituting a cheaper agent.
- The ceiling is a **deployment config value, defaulting to `STANDARD`**, raisable — not a constant.
- Lift it deliberately once Run Manager's atomic pre-flight budget gate exists (task C10), since spend caps address the real objection to unbounded tiers.

Rationale and rejected alternatives: [`phase-0-decisions.md` §0.3](../../phase-0-decisions.md). Was issue #125 on the frozen `alter-x-4-` repo.

## What the finished component looks like

- [ ] Idempotent per tenant, workspace and capability set — a retrying caller stops writing a row per attempt.
- [ ] Tier behaviour per decision 0.3.
- [x] Extracted as its own component with its own contract (task C7): imports nothing from Selection & Binding; shared types live in `src/agent_contracts`; `tests/test_agent_factory_boundary.py` keeps it so.

## Open issues

- [#125](https://github.com/havishalterx-eng/alter-x-4-/issues/125)

## Where this sits in the plan

See [`checklist.md`](../../checklist.md).

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
