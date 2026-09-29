# Owner decisions — 2026-09-29

Recorded live while Havish answered each open question, one at a time. Each entry: the question, the options put to him, his answer, and what it means for the build. This file goes into the repo as `docs/decisions/2026-09-29-owner-decisions.md`; the design log is amended where a decision changes it.

## D1. System identity for background jobs

**Question.** Platform work that runs with no user signed in (run-failed and approval notices, budget alerts, self-heal notices, drift suggestions) cannot read the engine or cost ledger today.

**Options put.** (a) a service identity on internal endpoints with an explicit tenant, per design log §30 (shared service token); (b) the engine pushes events to a platform-api endpoint (changes frozen Executor/Run Manager and makes the engine depend on the platform, against §22 item 11); (c) a system caller on the existing two-token path: the identity broker mints the short-lived, single-use actor token for a named system principal `system:platform-jobs` instead of a user, bound to one tenant, with a fixed read-only permission set, and the engine validates it like any call; (d) an outbox and queue from the engine's run-event journal (solves notices only, not budget reads); (e) no background work.

**Answer: (c) the system caller.**

**What it means.** The actor-token validator (`packages/auth`) accepts a principal type `system` with no user id, only for the fixed permission set; the identity broker gains a mint path for `system:platform-jobs` usable only by platform-api's own jobs, never by a request; the engine records the principal type in its audit. Background jobs (notification producers, budget threshold checks, drift suggestion delivery, self-heal notices) use it. If `packages/auth` counts as frozen core at build time, the builder stops and asks.

## D2. Retention and deletion (C3, C45, workspace delete)

**Question.** What erasure keeps after a tenant or member deletion, for how long, and what deleting a workspace does. Needed before the erasure providers for the 62 unreached tables (C3b) can be written.

**Options put.** (2a) minimised audit skeleton after account deletion held 30 or 90 days; (2b) which records the law requires kept longer; (2c) workspace delete: immediate erasure after a typed-name confirmation, or a short undo window.

**Answers.**
- **2a: 90 days.** The minimised audit skeleton (what happened, when, under which identifier; no content, no payloads) is held 90 days after the tenant is deleted, then destroyed.
- **2b: keep what the law prescribes, for exactly the prescribed period, and nothing else.** Recommended periods, to be confirmed with the company's CA before launch: tax invoices and billing records about 72 months (GST); books of account about 8 years (Companies Act); seller KYC and payout records about 5 years after the relationship ends (PMLA). These go to a separate legal-hold store holding the minimum fields, and are destroyed when their period ends. **Staff access logs: 90 days**, the same window as the audit skeleton. Everything else is destroyed immediately (§18).
- **2c: a small undo window for workspace deletion.** Deleting a workspace (typed-name confirmation) moves it to a pending-deletion state: hidden, its triggers and schedules paused, no runs start, data untouched. The owner or an admin can restore it during the window. When the window ends, the workspace's data is erased by the same schema-derived path as §18. The window length is a configuration value; **default 7 days** unless Havish sets another.

**What it means.** C3b builds the erasure providers against these rules; the legal-hold store and its periods are configuration; the retention sweeper destroys legal-hold rows at period end; workspace delete gets a pending-deletion state with restore and a scheduled erase. The periods in 2b are an engineering reading of Indian law, not legal advice.
