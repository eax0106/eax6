# Owner decisions — 2026-09-29

Recorded live while Havish answered each open question, one at a time. Each entry: the question, the options put to him, his answer, and what it means for the build. This file goes into the repo as `docs/decisions/2026-09-29-owner-decisions.md`; the design log is amended where a decision changes it.

## D1. System identity for background jobs

**Question.** Platform work that runs with no user signed in (run-failed and approval notices, budget alerts, self-heal notices, drift suggestions) cannot read the engine or cost ledger today.

**Options put.** (a) a service identity on internal endpoints with an explicit tenant, per design log §30 (shared service token); (b) the engine pushes events to a platform-api endpoint (changes frozen Executor/Run Manager and makes the engine depend on the platform, against §22 item 11); (c) a system caller on the existing two-token path: the identity broker mints the short-lived, single-use actor token for a named system principal `system:platform-jobs` instead of a user, bound to one tenant, with a fixed read-only permission set, and the engine validates it like any call; (d) an outbox and queue from the engine's run-event journal (solves notices only, not budget reads); (e) no background work.

**Answer: (c) the system caller.**

**What it means.** The actor-token validator (`packages/auth`) accepts a principal type `system` with no user id, only for the fixed permission set; the identity broker gains a mint path for `system:platform-jobs` usable only by platform-api's own jobs, never by a request; the engine records the principal type in its audit. Background jobs (notification producers, budget threshold checks, drift suggestion delivery, self-heal notices) use it. If `packages/auth` counts as frozen core at build time, the builder stops and asks.
