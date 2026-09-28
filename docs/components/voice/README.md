# Voice

**Layer** engine · **Plane** contracts only · **Category** 4 — build from scratch

> Either never implemented, or implemented in a shape that reproduces the flaw when ported.

## What it is

A declared voice surface: number binding, call handling, outbound calls, account health.

## Blast radius and fail mode

| | |
|---|---|
| Blast radius | `nothing` |
| Fail mode | `fail-closed` |

*No contract covers this component: scope undecided (open question 2). These values stay proposed (task C13).*

## Where the code lives

**Nowhere.** No implementation exists in this repository.

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

`VoiceService` declares six RPCs — `BindNumber`, `GetNumberBinding`, `ConfigureCallHandling`, `InitiateCall`, `GetAccountHealth`, `GetCapabilities` — and **no implementation was found under `apps/`**. No telephony vendor appears anywhere in the repository. Listed as the honest reading of a contract with nothing behind it.

## Design-log alignment — `SILENT`

**The design log never mentions voice once.** Not deferred the way Project Mode is explicitly deferred in §23 — simply absent. This is the one place the assessment and the design log disagree about what the product is. Needs a telephony vendor, a number-provisioning story, and a decision about whether voice is in the first release at all (decision 0.6).

## Decision — 2026-09-08 · design log §33 · **CUT FROM v1**

**Cut.** Six RPCs declared, no implementation under `apps/`, no telephony vendor anywhere in the repository, and the design log never mentioned voice at all — unlike Project Mode, which §23 deferred explicitly.

**Checked before deciding:** Axon, the voice product elsewhere in the portfolio, is separate and does **not** run on this engine. Nothing outside the engine argued for keeping it.

**Decided, not executed.** Cutting means **removing or deprecating the declaration** — a note is not a cut. While `VoiceService` remains declared it still generates clients, still appears in counts, and still sits inside every estimate of remaining work, which is the entire cost that made this worth deciding. Task 5.1 stays open until the declaration is gone.

If voice returns it returns as a scoped addition with a named vendor, never as a rediscovered obligation.

Rationale: [`phase-0-decisions.md` §0.6](../../phase-0-decisions.md).

## What the finished component looks like

- [ ] Either ships with a chosen vendor, or is **explicitly cut** and its contract marked as such, so it stops appearing in counts as pending work.

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md) — task **5.1**.

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
