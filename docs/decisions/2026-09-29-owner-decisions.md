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

## D9. Folders and cross-workflow context (design log §10)

**Answers (Havish took each recommendation).**
- **9a: simple folders, engine-owned.** A folder is a named record in the engine (tenant RLS, workspace-scoped, erasure-registered). A workflow has an optional folder; none means "Ungrouped". Create, rename, delete (its workflows return to Ungrouped, never deleted), move a workflow. Engine projects keep their Project Studio meaning and are not reused as folders.
- **9b: cross-workflow context stays within the workspace.** Retrieval spans every workflow in the workspace, never across workspaces, because workspaces are permission boundaries.

**What it means.** Engine folders table and routes; `folder_id` on workflows; platform-api proxies; web sidebar groups by folder with an Ungrouped bucket. ADS retrieval unchanged (already workspace-scoped); §10's wording amended.

## D10. Workflow health scoring

**Question.** The web shows a health report per workflow (four dimensions, overall score, status); nothing computes it.

**Answer: the proposal as put.**
- **Validation:** latest validate/compile result: pass 100, warnings 70, fail 0.
- **Availability:** active with every required connection healthy 100; paused 50; a required connection broken 0.
- **Correctness:** share of runs passing verification (node and end-of-run), 0-100.
- **Reliability:** share of runs completing rather than failing, 0-100.
- **Window:** last 20 runs or last 7 days, whichever is smaller. **Overall:** average of the four. **Status from the worst dimension:** critical if any below 50, warning if any below 80, else healthy. **No runs yet:** "not enough data", never a default 100. Also shown: recent failures and degraded runs (finished but needed recovery).

**What it means.** An engine read computing these from runs, verification_results, recovery actions and connection health; platform-api route; web health views wired.

## D11. Event replay

**Question.** The events page's Replay does nothing; a real re-run repeats the workflow's outside actions, and the side-effect ledger (C8) guards retries within one run, not a new run.

**Options put.** (a) replay for real; (b) dry run only, through the existing Simulate action; (c) both: Replay is a dry run by default, and "Replay for real" is a separate action with a confirmation naming the outside actions that will repeat.

**Answer: (c).** Replay runs the workflow's Simulate action on the stored event and shows what each step would do, touching nothing outside. "Replay for real" starts a new run from the stored event after a confirmation that lists the outside actions it will repeat (counted from the workflow's side-effect tools), and records who confirmed it.

**What it means.** Engine replay route (dry run via simulate; real via a new run with the stored payload and a `replayed_from` link); platform-api routes (real replay needs the workflow run permission and the confirmation token); web Replay and "Replay for real" with the confirmation.

## D12. Memory settings

**Question.** The memory settings page's five controls (chat, workflow and workspace memory switches, a retention period, an "allow sensitive data" switch) govern nothing.

**Options put.** (a) make all five work; (b) make four work and keep "allow sensitive data" permanently off for v1; (c) remove the page for v1.

**Answer: (b).** Chat memory (the workflow's chat recalls earlier messages when building), workflow memory (lessons from a workflow's past runs reused in it) and workspace memory (lessons shared across the workspace through the ADS memory store) are real switches, all on by default, each checked by memory-service before it writes or reads that kind of memory. Retention: 7 to 365 days, default 90; older memories are deleted by the retention sweep. "Allow sensitive data" is removed for v1 (memories are always stored with PII redacted). The anonymised cross-tenant policy learning of §2 is unaffected.

**What it means.** A per-workspace memory settings record (engine or memory-service, tenant RLS) with a read and an If-Match write route; memory-service enforces the switches and the retention window; platform-api routes; web page wired without the sensitive-data switch.

## D13. Four design-log amendments from Track D (D-4a with D-4c, D-7a, D-23a, D-32a)

**Question.** Four places where the conformance pass found the code right and the log out of date: accept each amendment (the log changes) or reject it (the code changes).

**Answer: accept all four.**
1. **§4 (D-4a, D-4c).** The classify stage uses the code's ten failure classes (`packages/contracts/src/recovery-classification.ts`), mapped onto the log's five buckets: transient = timeout, infrastructure_failure, rate_limit, sandbox_crash; node's own fault = logic_output_failure, agent_creation_failure; credential gap = credential_missing, tool_permission_denial; safety_violation is handled outside Recovery (C40); unknown goes to a person. A transient failure that repeats is retried once, then the node is swapped. The two buckets with no class yet (target resource missing, genuinely ambiguous outcome) get classes of their own (D-4b), now buildable.
2. **§7 pattern 1 (D-7a).** Enforced by the mock-reachability gate and the `RUNTIME_MODE` boot check (a mock in production is a boot error), not by a marker type.
3. **§23 (D-23a).** Project Mode code is present but not offered in the v1 interface; it is not removed.
4. **§32 (D-32a).** Closed on 2026-09-14 by deleting the write-only columns.

**What it means.** The log sections are amended; Recovery gains the two missing failure classes and their routes (target missing: ask the user to redirect or recreate; ambiguous: clarification only, never retry or swap), and self-heal notices reach the user through the D1 system caller.

## D14. Read-back of emails and clicks (design log §5.2)

**Question.** An email passes on provider acceptance (it may bounce later); a browser click is recorded as unconfirmable.

**Options put.** (a) accept today's level for v1; (b) full read-back: SES delivery events for every email and a page snapshot after every click (one extra paid Browserbase call per click); (c) split: SES delivery events wired, step passes on acceptance, a later bounce flags the run and notifies the owner; a click snapshot only when the step declares the expected page state, otherwise "unconfirmed", clearly labelled.

**Answer: (c).**

**What it means.** SES configuration set with delivery and bounce events (SNS or EventBridge, provisioned with the EC2 kit, 6.1b) into an engine endpoint that updates the side-effect record by provider message id; a bounce marks the run "delivery failed" and notifies through the D1 system caller. ToolCall browser.click takes a snapshot and checks it only when the node config states the expected page state (text or selector); otherwise the result stays "unconfirmed".

## D15. Safety library shape (C4, design log §11, planes rule 37)

**Question.** §11 wants the SSRF guard, prompt-injection classifier and PII redaction in one shared package; today there is one of each, in `packages/adapters` and `packages/auth`, plus a Python mirror of the injection classifier, and the imported gate flags every raw fetch (34).

**Options put.** (a) relocate into a single `packages/safety` (touches frozen Model Gateway and Conversation Manager, no behaviour change); (b) amend §11 to "one implementation per language", add a parity test and narrow the gate.

**Answer: (b).** Exactly one implementation per language (TypeScript, Python). A parity test runs both injection classifiers over one shared case set and fails if they disagree, in CI. The architecture gate is narrowed from "any raw fetch" to real duplicate safety logic (a second SSRF guard, classifier or redactor), and its baseline is regenerated with the count reported.

**What it means.** Shared case file, parity spec wired into CI, gate rule change with a proven-to-fail case; §11 and planes rule 37 amended.

## D16. Hosted public form (design log §25)

**Question.** Alter cannot host a form; public input is webhooks only, though §1's own example is a lead-capture form.

**Options put.** (a) webhooks only for v1; (b) a minimal hosted form (fields on the trigger, public link `/f/<token>`, Cloudflare Turnstile, per-form and per-visitor rate limits, D15 safety checks on input, no uploads in v1, its own component); (c) a full form builder.

**Answer: (b), as an option, not the default.** The primary input stays the user's own source (their existing form tool, CRM or site connected through a connector or webhook). When a user sets up a trigger for incoming submissions, Alter offers the hosted form as one choice alongside connecting their own; it is never created unless chosen.

**What it means.** Public Surface component (separate process, own rate limits); form definition on the trigger; hosted page and submission endpoint; Turnstile verification (site key and secret as configuration); submissions become trigger events.

## D17. The "Session Gateway" rename (design log §26)

**Question.** §26 renamed "Session Gateway" to "Identity & Tenant Gateway"; the old name remains in 61 files, including `packages/auth` and contracts.

**Options put.** (a) rename all 61 files now; (b) rename when touched, with a CI check that blocks the old name in new lines.

**Answer: (b).** New code and documents use "Identity & Tenant Gateway"; existing occurrences are renamed when their file is edited for another reason; a `scripts/check-*.sh` gate in CI fails on "Session Gateway" (and `SessionGateway` identifiers) appearing in added lines, with a baseline of today's occurrences.

**What it means.** One CI gate with a baseline and a proven-to-fail case; §26 amended.

## D18. Starter templates (design log §19, C38)

**Question.** §19 requires a small curated set of hand-authored templates on the first-run screen, stored in the Capability Registry; none exist.

**Options put.** (a) Havish writes them; (b) the builder session writes a first set of 8 and Havish reviews them before launch; (c) no templates at launch.

**Answer: (b).** First set: (1) lead capture to CRM plus welcome email; (2) support email triage, label and route; (3) invoice email, extract details, sheet row; (4) weekly report digest by email; (5) knowledge Q&A over uploaded documents; (6) meeting notes to summary email with action items; (7) brand mention monitoring with alert; (8) WhatsApp FAQ responder (usable once the Meta account exists). Alter-authored only, never harvested from tenant workflows (§19). Each template must compile and pass its own success criteria in a test before it ships; Havish reviews the set before launch.

**What it means.** Template store in the Capability Registry (C38, covered by the 2026-09-28 exemption) with list and instantiate routes; the first-run screen shows them below the describe box; instantiating creates a workflow and its chat (D6).

## D19. Which connection store is authoritative (C41, design log §4)

**Question.** Users connect accounts in platform-api (`oauth_connections`); Tool Gateway uses credentials at run time; nothing maps one to the other, and §4 wants a pre-compile live-connection check with one batch "connect these" ask. The engine must never depend on the platform (§22 item 11).

**Options put.** (a) platform-api authoritative, the engine asks it (breaks §22 item 11); (b) Tool Gateway authoritative, users connect in two places; (c) the platform writes, the engine holds the record.

**Answer: (c).** Users connect accounts in the platform as now. On every connect, reconnect, revoke or health change, platform-api upserts an engine connection record (connector type, status, secret reference; never the token). The engine is authoritative at compile and run time: the Capability Resolver checks every required capability against those records before compiling and returns one batch list of missing connections; Tool Gateway resolves credentials through the record's secret reference. The platform's existing health sweep re-sends all records so a lost update heals; a missing or broken credential at run time is still a credential gap (§4 bucket 3), never silent. Havish granted the freeze exemption for the compile-path change this needs.

**What it means.** Engine connection registry (tenant RLS, erasure-registered) with an upsert route for platform-api; platform-api calls it from the connection lifecycle and the health sweep; pre-compile check and batch ask in the compile path; Tool Gateway credential resolution through the registry. Record the exemption in memoryalter §2 before code.

## D20. Manual override advisory thresholds (C42, design log §8)

**Question.** §8's pre-flight advisory warns on a manual model or tool override only when the difference is material; the canvas has no per-node override yet and "material" was undefined.

**Answer: the proposal as put.** The canvas gains per-node model and tool override, and the advisory warns when the override: raises estimated cost per run by 25% or more **and** by at least ₹5; drops below the node's required model tier; picks a tool lacking a required capability; adds an outside action or wider account scope; makes the node 2x slower or more (expected latency); or changes the node's output so a downstream node's input no longer fits. Any one triggers the warning, which shows Alter's original pick and reasoning (the Selection & Binding scores) and never blocks. Every manual edit also re-runs DAG validation (§8).

**What it means.** Override fields on compiled nodes, a comparison endpoint reusing Selection & Binding scoring and the D4 cost bound, canvas override panel with the advisory; thresholds are configuration.

## D21. Tool package scanner (B3.5)

**Question.** No package scanner is wired, so every tool version scans "unavailable" and none can be verified clean.

**Options put.** (a) OSV-Scanner (free, known vulnerabilities in dependencies); (b) Socket (paid, also malicious-package signals); (c) Snyk (paid, vulnerabilities and licences); (d) manual staff review only.

**Answer: (a), with staff review of each tool's first published version; add Socket later when outside publishers can publish.**

**What it means.** An OSV-Scanner adapter behind the registry's scanner port (verdicts: clean, vulnerable with severity, error); a tool's first version stays unverified until a staff reviewer approves it; later versions need a clean scan; the scanner port keeps Socket addable.

## D22. Payments (B2.3, B2.5, B2.6, design log §21)

**Answers (Havish took each recommendation).**
- **22a: Razorpay Subscriptions** for checkout and recurring billing (card tokenization under RBI rules and UPI Autopay handled by Razorpay; no card vault of ours).
- **22b: prices shown exclusive of GST; 18% GST added at checkout; GSTIN captured** for business customers' input credit. Requires the company's GST registration; the rate and treatment to be confirmed with the CA.
- **22c: marketplace listings are free-only in v1.** Paid listings and seller payouts wait until the CA confirms the marketplace's TCS/TDS obligations and Razorpay Route is set up.
- **22d: Alter absorbs payment gateway fees** on subscriptions; customers pay the listed price.
- **22e: all prices are configuration placeholders, set by Havish before launch** (plan price, credits included, extra-credit price, credits per verified run, free-tier limit). The free tier carries abuse limits: verified email and a runs-per-day cap (§21).

**What it means.** Razorpay Subscriptions integration (create, webhook-driven status, cancel), checkout with GST line and GSTIN, invoices already rendered by Razorpay (B2.7); paid marketplace flows hidden in v1; pricing and free-tier limits in the plan-definition configuration. Tax treatment is an engineering reading, not legal advice.

## D23. Seller KYC (B2.4)

**Question.** Sellers cannot submit identity documents in live mode: no document store, no KYC vendor. Staff KYC review exists. D22 made listings free-only in v1.

**Options put.** (a) Razorpay Route linked-account KYC (Razorpay holds the documents); (b) a separate KYC vendor; (c) our own encrypted document store.

**Answer: (a), switched on with paid listings.** Until paid listings exist, sellers publish free listings without uploading documents; staff review stays. When paid listings arrive, each seller onboards as a Razorpay Route linked account and Razorpay collects and verifies their documents; Alter stores no identity documents, only the linked-account id and its KYC status.

**What it means.** No document upload built for v1; the seller upload screen stays hidden in live mode; the Route linked-account flow is built with paid listings.

## D24. What tenants see of cost

**Question.** `GET /api/v1/costs/summary`, readable by any workspace member with `billing:read`, returns the ledger's internal cost, retry and recovery cost, and margin; the web shows only billable spend, but the API exposes the rest.

**Options put.** (a) strip internal, retry and recovery cost and margin from the tenant route, and add a staff-only route with the full breakdown; (b) leave it.

**Answer: (a).** Tenants see what each workflow (and run) costs **them**: the full price after Alter's cut is included. They never see Alter's internal cost or its margin.

**What it means.** The tenant cost routes return the billed price only, per workflow and per run as well as by month (with a test that fails if an internal-cost or margin field reappears); a staff-only admin route (staff role, audited) returns the full breakdown.

## D25. Benchmarks (B3.2)

**Question.** The customer console has a Benchmarks area (hidden in live mode, its calls mock); the engine has no tenant datasets or tenant eval runs, only Alter's golden sets and a staff-run release gate.

**Options put.** (a) staff-only eval history in the admin console; (b) tenant datasets and benchmark runs in eval-service; (c) drop from v1.

**Answer: both (a) and (b), in scope now,** so the feature can be tested.
- **(a) Staff:** the admin console lists golden-set runs over time with their scores (a list-runs read on eval-service).
- **(b) Tenants:** a workspace can create benchmark datasets (test cases: an input plus the success criteria it should meet), run a workflow against a dataset, and see per-case and overall pass rates over time. Benchmark runs execute through Simulate (D11), so no outside action ever fires; each case is judged by the Verification & Quality Gate against its criteria; runs are costed and billed like other model use.

**What it means.** eval-service tenant datasets and runs (tenant RLS, erasure-registered), a list-runs read for staff, platform-api routes, the customer Benchmarks area un-hidden and wired, the staff history view in the admin console.

## D26. Admin console hidden screens (B1.1, B1.2, B1.6/B1.7, B1.8, B1.11, B2.2)

**Answer: build or drop as recommended.**
- **Build:** tenant detail (members, workflows, runs in the last 30 days, spend; read-only); tenant notes and user notes (staff-only, audited, append-only history); assign a security review to a staff member; billing ops retry charge, apply credit and resolve (through Razorpay, D22, audited with a reason); the deployments page re-scoped to tenant deployments (list plus rollback, suspend, resume, audited).
- **Drop (removed from the admin UI):** a "restricted" tenant state (suspend covers it); MFA and risk display (Auth0 shows it; the user screen links there instead); provider "maintenance" state (enable/disable covers it); editing policies from the list page (policy changes go through reviewed configuration).

**What it means.** The build items get platform-api staff routes (staff roles, audited, reason where the action changes state) and web wiring; the drop items are removed from the web, not hidden.

## D27. Marketplace "needs changes" and risk score (B2.1)

**Answer: build both.**
- **Needs changes:** a governance status with reviewer notes; the seller edits and resubmits, which returns the listing to the review queue; every transition audited with a reason.
- **Risk score:** computed only from real signals: the latest scanner verdict (D21), whether it is the seller's first listing, the outside actions the tool can perform (side-effect tools, account scopes), and prior reports or takedowns. The score shows its reasons beside it, orders the review queue, and never approves or rejects anything by itself.

**What it means.** Governance status and notes, resubmit route, a risk computation over existing data, review queue sorted by risk with reasons shown; the web's hidden controls wired.

## D28. Image publishing (C32)

**Question.** The `images` workflow builds but cannot push: the `ghcr.io/havishalterx-eng/alter-*` packages were created by alter-x-4-, so only that repository may write them.

**Options put.** (a) grant alterengine-6 write access to the existing packages and remove alter-x-4-'s access; (b) rename our images; (c) turn off publishing here.

**Answer: (a).** Owner action (Havish, in GitHub): for each `alter-*` package under havishalterx-eng, Package settings, Manage Actions access, add `alterengine-6` with Write, and remove `alter-x-4-`. Image names, the EC2 kit and compose files stay unchanged. After the change, re-run the `images` workflow on main and confirm it pushes.

## D29. Private security items

**Answer: go-ahead** on the private security items reported to Havish in chat (three earlier items, including C48's internal-route credential using the shared internal service token under §30, and the two later items). Details are deliberately not recorded in this public repository; the build instructions carry them privately.

## Owner actions (Havish), collected

1. **GitHub packages (D28):** give `alterengine-6` Write on each `alter-*` package, remove `alter-x-4-`.
2. **CA confirmation (D2, D22):** legal retention periods; GST rate and treatment; marketplace TCS/TDS before paid listings.
3. **Prices (D22):** plan price, included credits, extra-credit price, credits per verified run, free-tier limit, before launch.
4. **Template review (D18):** review the eight starter templates before launch.
