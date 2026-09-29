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

## D4. Pre-run estimate and run reservation (C43, design log §9)

**Question.** §9 requires an estimate shown before every run, and D3's atomic budget check needs an amount to reserve at run start. Nothing produces a per-workflow figure today.

**Options put.** (a) historical average of the workflow's last N verified runs; (b) a worst-case bound from each node's configured `max_tokens` times its model alias price, plus fixed tool-call costs; (c) both: show "usually X (last N runs), at most Y (worst case)", only "at most Y" until N runs exist, reserve Y at start and true up to actual cost at the end.

**Answer: (c), with N = 5.** Havish also granted the **Cost Ledger freeze exemption for this item** (the ledger gains a per-workflow cost read), since C43 was not covered by the 2026-09-28 exemption.

**What it means.** Cost Ledger records workflow id on run costs and answers the average of a workflow's last 5 verified runs; the engine computes the worst-case bound from the compiled DAG (node `max_tokens`, alias prices from the model policy, fixed tool costs); the estimate is shown before every run; Run Manager reserves the worst-case amount at start (D3) and releases or trues up at run end. §9's rounding rule holds: multiply unrounded unit prices, round once at the end. Record this exemption in memoryalter §2 before code, as the freeze rule requires.

## D5. Approval modes and approval delivery (C30, design log §16)

**Question.** Only "wait until someone decides" exists today; §16 describes four modes and left open how an approver is told.

**Options put.** (5a) build all four §16 modes (always block, auto-approve with an audit record, skip on timeout and flag, promotion suggested after N consecutive approvals and confirmed by a person); (5b) delivery: in-app only, in-app plus email, or plus WhatsApp. Follow-up: whether "always go ahead" may be set on steps that act outside Alter.

**Answers.**
- **5a: all four modes, N = 10.** The main control on every approval step is a two-choice switch chosen by a person with approval rights: **"Ask me first"** (always block) or **"Always go ahead"** (auto-approve, every run still recorded as "approved by policy"). Skip-on-timeout (with its window) and the promotion suggestion ("you have approved the last 10 in a row: switch to Always go ahead?", never applied without a person confirming) are additional settings on the step.
- **Follow-up: option (ii).** "Always go ahead" may be chosen on any step, including steps that act outside Alter (email, database writes, browser clicks), but only through an explicit confirmation naming the consequence ("this will send emails without asking"), and the choice records who made it and when. It is never a default.
- **5b: in-app plus email.** Bell and Action Centre always; email per user preference, on by default for approvals; WhatsApp later as a preference once the Meta account exists. Sent through the D1 system caller.

**What it means.** Approval mode stored on the node (engine approval record keeps the mode used and who set it); auto-approve and timeout paths in the Executor's approval wait; a promotion-suggestion counter per node; approval notification producer and email template. This amends the adopted rule "a workflow may add safeguards but never remove one" for one case: a person with approval rights may, with an explicit confirmation and an audit record, set an external-action step to go ahead without asking.

## D6. What a chat is (design log §10, §27 surface 1)

**Question.** The web chat is mock in live mode; the engine's conversations table has no title, no messages and no workflow link, and nothing decides what the assistant replies.

**Options put.** (a) one workflow = one chat (§10), replies only from the builder pipeline; (b) a free-standing assistant that can create and edit any workflow; (c) both: per-workflow chats plus one cross-workflow assistant.

**Answer: one workflow = one chat, plus a read-only assistant.**
- **Per-workflow chat.** Every workflow has exactly one chat; it is where the workflow is built and changed. Messages go through the builder pipeline (understand, plan, clarify, compile) and the reply says what changed. The home page's "describe it" box creates a new workflow and its chat together.
- **Assistant ("Ask Alter").** One assistant per user, across the workspace's workflows. It **has no power to change anything**: it answers questions and gives updates on the user's other workflows (status, recent runs, failures, verification results, spend), grounded only in data the user can already read. Its one action is to **start a new workflow**: it creates the new, empty workflow and its chat and sends the user there, where the workflow's own chat does the building.

**What it means.** Engine stores chat messages (tenant RLS, erasure-registered), each workflow chat linked to its workflow; chat title is the workflow name; archiving a chat archives nothing else. The assistant is a separate conversation per user, read-only over the engine's run, verification and cost reads through the caller's own identity (it can see only what the user can see), with a single write: create a draft workflow and return its chat. Its answers are model calls and are costed like any other.

## D7. Members: invites, roles, custom roles (design log §15, §20)

**Question.** Live invites are broken (the web sends an email; the API wants an existing user id); the members screen's roles do not match the enforced workspace roles; §15 wanted custom roles.

**Answers (Havish took each recommendation).**
- **7a: hybrid invites.** Our own invitation record is the source of truth (tenant RLS: email, role, workspace, status, expiry 7 days, invited by). Auth0 Organization invitations deliver the email and the hosted sign-up link. On the invitee's first sign-in the callback matches the invitation and creates the membership with the chosen role. Resend issues a fresh invitation; revoke cancels one. Pending invitations appear in the members list as "invited". The mock identity provider mirrors this locally.
- **7b: the members screen shows the five enforced workspace roles** (admin, editor, operator, approver, viewer) plus the tenant owner badge. Role change is wired to a new members route (workspace admin, audited, cannot demote the last admin, owner not changeable through it).
- **7c: fixed roles for v1; custom roles later.** §15's custom roles are deferred. The role model already stores a role as name plus permission set, so custom roles remain an addition, not a redesign.

**What it means.** Invitation table and routes (create, list, resend, revoke), Auth0 invitation adapter and mock mirror, acceptance on callback; web invite dialog and member menu use the real roles; `PATCH` member role route with safeguards and audit. Password change stays with the identity provider (Auth0's change-password email), wired from the security page.

## D8. Success criteria shown and confirmed (design log §5.1)

**Question.** The model infers each workflow's success criteria and nobody sees them, though the end-of-run check judges runs against them.

**Options put.** (a) show them in the existing plan step, editable, with Build as confirmation; (b) a separate required confirmation step; (c) amend §5.1 to "inferred, shown, editable" without confirmation.

**Answer: (a).** The plan screen lists the success criteria beside the steps; the user can edit, add or remove them; pressing Build confirms them. A user-added criterion that no step covers makes the planner fail loudly and ask (C29 rule), never silently dropped. An edit to a live workflow that touches what the criteria depend on asks whether the goal changed (§8).

**What it means.** Criteria returned with the plan and accepted back on build (editable list); planner re-assigns edited criteria to nodes; web plan step shows and edits them.
