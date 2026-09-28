# Tool Gateway

**Layer** L7 · **Plane** tool-gateway · **Category** 3 — needs fixes or missing methods

> Both ends exist and the call is made, and something along the path is wrong. A source read marks
> these as finished, because from the source both halves look complete.

## What it is

The single route from a node to the outside world: HTTP, browser, connector and internal tool families, with credential resolution and token minting behind it.

## Blast radius, fail mode and driver

**Contract 27 — Tool Gateway** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | this-layer-only, severe: tool-performing nodes fail **and** mechanical verification cannot run. |
| Fail mode | fail-closed. No action without a recorded effect (contract 24). No action without resolved permission. No unbounded response reads. |
| Driver | invoked by Executor and by Verification. *Driver test:* both callers work — a node performs a real external action, and verification reads that same action back independently. |

*From the contract (task C13, decision 0.7). The contract's done gates are targets, not gates that fail today.*

## Where the code lives

- `apps/tool-gateway/src/gateway`
- `apps/tool-gateway/src/testing`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

Four tool families dispatch. **The denominator is unpinned — no protocol enum exists, and a live probe found three unimplemented, not two.** A separate defect reporting a missing field as `INTERNAL` was found and fixed during this pass (#110 — third instance of that defect class).

## Design-log alignment — `NEEDS-LOGIC`

Design log §7 pattern 4 (single source of truth per shared primitive) and §14's registry precedent both apply: a real enum means a new protocol is an entry rather than an edit to what consumes it.

§11 names Tool Gateway a primary consumer of the shared in-process safety library, and gives the concrete reason: the old build's Tool Gateway fetcher had **no response-size cap while Sandbox's did** — the same logic reimplemented twice, drifted apart, one wrong.

§4 places credential resolution here, with a batch-ask flow: Alter asks for all needed connectors **after the Architecture Synthesizer finishes**, not one-by-one mid-conversation, because the full tool list is not known until the design is complete.

## What the finished component looks like

- [ ] A protocol enum exists, so the count of what is missing is a fact rather than an estimate.
- [ ] Safety logic imported in-process from one package, not reimplemented (§11).
- [ ] Browserbase or equivalent wired for the five browser tools.

## Open issues

- [#110 (fixed)](https://github.com/havishalterx-eng/alter-x-4-/issues/110)

## Where this sits in the plan

See [`checklist.md`](../../checklist.md).

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
