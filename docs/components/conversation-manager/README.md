# Conversation Manager

**Layer** L1 · **Plane** orchestration · **Category** 1 — works end to end

> **Do not change this component's logic or code during revival.** It is one of the 25 verified
> end to end on 4–6 September 2026, and it is the only verified value in the system. Anything
> necessary is recorded in [`memoryalter.md`](../../memoryalter.md) *before* it is made.

## What it is

The front door. Takes what a person says and works out what they actually want, including asking for clarification when the answer is genuinely ambiguous.

## Blast radius, fail mode and driver

**Contract 3 — Conversation Manager** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | degraded (self only). If this is unavailable, users cannot start or modify workflows — but **in-flight runs continue unaffected**, because the run path never touches it (design log Section 24, two-path model). This is the two-path model paying off concretely: a design-path outage must not stop the run path. |
| Fail mode | fail-closed on ambiguity. When intent cannot be confidently classified, ask the user (route to **8. Clarification Loop**) rather than guessing. Guessing here silently misroutes the entire downstream pipeline. |
| Driver | invoked per user message by **48. Platform API/BFF**. *Driver test:* a message sent through the real Platform API arrives here, is classified, and the classification reaches the next component. |

*From the contract (task C13, decision 0.7). The contract's done gates are targets, not gates that fail today.*

## Where the code lives

- `apps/orchestration-service/src/conversation`
- `apps/orchestration-service/src/clarifications`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

All three RPCs answer. **`ClassifyIntent` is genuinely model-backed** — it screens the utterance through a prompt-injection classifier, calls the Model Gateway with a classification prompt and parses the reply against a five-value taxonomy — rather than matching keywords the way the Planner does. **Its classification quality cannot be judged locally**: the mock provider returns one canned structured reply, so every utterance comes back `answer` at 0.9. That is the mock, not the classifier. Two defects found and fixed here (#120).

## Design-log alignment — `ALIGNED`

Design log §4 bucket 5 routes genuinely ambiguous outcomes here and nowhere else — never to retry or swap, because retrying an ambiguous-but-not-broken result just reproduces the same ambiguity.

## What the finished component looks like

- [ ] Different utterances return different intents against a real provider — the explicit Phase 1 done gate.
- [ ] The Clarification Loop reachable from Recovery's bucket 5.

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md).

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
