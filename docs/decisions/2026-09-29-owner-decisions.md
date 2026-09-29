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

## D3. Budgets (C10, design log §9 and §22)

**Question.** Budgets exist (per workspace, monthly, in platform_db) but nothing enforces them, and §22 requires Run Manager to check the budget atomically at run start.

**Options put.** (3a) move budget records to the engine so Run Manager checks them atomically, or keep them in platform_db and amend §22 (non-atomic, parallel runs can overspend); (3b) which budget kinds; (3c) behaviour at the cap.

**Answers (Havish took each recommendation).**
- **3a: budgets move to the engine.** Run Manager owns the budget records and makes the start-of-run check atomic against them (row lock or conditional update, so two parallel runs cannot both pass); platform-api proxies budget reads and writes to the engine, as it does for workflows. The platform_db `budgets` table (migration 0024, B2.9b) is migrated to the engine and retired. Run Manager is frozen core; the 2026-09-28 exemption covers C10.
- **3b: every kind in §9, plus the existing workspace budget.** Per-run hard cap (optional, set per workflow); per-workflow budget, daily or monthly; per-workspace monthly budget kept as the umbrella; threshold alerts at 50% and 80% (delivered through the D1 system caller and notifications).
- **3c: hard stop by default, "warn only" as a per-budget option.** At the cap, runs do not start until the period resets or the cap is raised; a budget marked warn-only alerts but does not block, an explicit user choice recorded on the budget.

**What it means.** Engine budget store with tenant RLS and erasure registration; atomic check-and-reserve at run start in Run Manager; reservation released or trued up at run end (the reservation amount comes from D4); platform-api budget routes become engine proxies; threshold alert job on the system caller.
