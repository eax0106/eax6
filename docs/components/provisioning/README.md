# Provisioning

**Layer** L6 · **Plane** provisioning · **Category** 1 — works end to end

> **Do not change this component's logic or code during revival.** It is one of the 25 verified
> end to end on 4–6 September 2026, and it is the only verified value in the system. Anything
> necessary is recorded in [`memoryalter.md`](../../memoryalter.md) *before* it is made.

## What it is

Creates and closes the session and project directory a run needs to do work on disk.

## Blast radius, fail mode and driver

**Contract 23 — Provisioning** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | degraded (self only). Only nodes requiring an isolated runtime are affected; the rest of the workflow proceeds. |
| Fail mode | fail-closed. Never hand back a partially-prepared environment — a sandbox missing a dependency produces failures that look like code errors. |
| Driver | invoked by Executor for sandbox-requiring nodes. *Driver test:* a real sandbox-requiring node gets a working prepared environment. |

*From the contract (task C13, decision 0.7). The contract's done gates are targets, not gates that fail today.*

## Where the code lives

- `apps/provisioning-service/src/provisioning`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

Provision returns a session and project directory; `CloseCycle` closes it. No orphan left behind.

## Design-log alignment — `ALIGNED`

Design log §23: keep scoped small so Project Mode stays addable rather than requiring a rearchitecture. §26 also renamed away from 'session' language to kill the auth-session/chat-session collision — check naming here when touched.

## What the finished component looks like

- [ ] Stays narrow, same reasoning as SandboxExec.

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md).

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
