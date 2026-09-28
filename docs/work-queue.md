# Work queue — Phase 6, then Tracks B, C, D

Opened 2026-09-28 on Havish's instruction: finish the buildable part of Phase 6, then
conclude Track B, Track C and Track D, **one after another, nothing skipped**. Anything that
needs Havish's decision is not built on a guess — it moves to "Blocked on a decision" below and
is asked once everything buildable is done.

This file is the execution order. `checklist.md` stays the board; every item here is also an
item there. Status: `todo` · `doing` · `done (PR #n)` · `blocked (reason)`.

## Order

### Phase 6 — buildable part
| # | Item | Status |
|---|---|---|
| 6.1a | Single-EC2 deployment kit: Terraform for the host and every AWS resource LocalStack fakes locally, one compose file, bootstrap, runbook. Proven: terraform validate + real plan (24 resources), compose config, `check-bootstrap-env.sh`. Whole-stack run waits on 6.1b. | done (this PR) |
| 6.2a | Temporal Cloud wiring in the kit (address, namespace, API key from Secrets Manager, worker deployment name and build id from #222). | done (this PR) |
| 6.1c | platform_db runtime roles: the kit had platform-api connect as the Postgres superuser, which bypasses row-level security; it now connects as `platform_app` (held to RLS) and the staff plane as `platform_operations` (its `OPERATIONS_*_DATABASE_URL` were configured nowhere, so the security queue and marketplace governance would have answered 503). Proven by `check-platform-db-roles.sh` in CI. | done (this PR) |
| 6.1d | production boot: with `NODE_ENV=production` platform-api refused to start (mock identity, email and media; AppConfig ids it has no application for; three secret references), tool-gateway too (mock email), and orchestration (Session Gateway flag unset); platform-api's Engine clients had none of their eleven settings, their token pairs had no preimage, and orchestration fetched actor-token keys from port 3000 while platform-api listens on 3020. The kit now selects Auth0, SES, S3/Titan/Polly/Transcribe, resolves platform-api's env-var secret references, reads plan definitions from the bundled file, grants Polly/Transcribe, sets the Engine clients and generates their token pairs, and points the actor-token JWKS at platform-api's port. `check-production-boot.sh` in CI runs each service's own selection code over every container's compose-resolved environment. Generated secret files are now git-ignored | done (this PR) |
| 6.1b | Launch on EC2 | blocked (accounts + cost, below) |
| 6.2b | Run against Temporal Cloud | blocked (account) |
| 6.5 | Load and failure evidence; promotion gate | blocked (needs 6.1b) |

### Track B — platform wiring
| # | Item | Status |
|---|---|---|
| B1.0 | Staff sign-in for the admin console: nothing issued the staff cookie, so no admin screen could ever authenticate. PKCE against the staff Auth0 tenant, cookie only for recognised staff, live-mode gate and callback page. | done (this PR) |
| B1.1 | admin-tenants: list, detail behind the support-grant gate (staff admin self-grant with reason and duration), suspend, reinstate, action history as the timeline; admin console gated per section | done (this PR) |
| B1.2 | admin-users: suspension now enforced (session store accepts only active users), cross-tenant list and detail, suspend (revokes every session), reinstate, revoke sessions, append-only history, audit | done (this PR) |
| B1.3 | audit explorer over the audit ledger | done (this PR) |
| B1.4 | feature flags: list, toggle (reason recorded) | done (this PR) |
| B1.5 | incidents: list, detail, and a new status transition route (draft to investigating, then investigating/monitoring/resolved, reopen; conditional on current status, audited) | done (this PR) |
| B1.6 | policies: plan limits and model alias bindings, read-only | done (this PR) |
| B1.7 | providers: list, enable/disable (reason recorded); system status reads the same | done (this PR) |
| B1.8 | security: abuse signals as review items, confirm/dismiss with reason | done (this PR) |
| B1.9 | support access: JIT grants listed with derived status, end session revokes | done (this PR) |
| B1.10 | usage | moved to B2: it is the tenant's own usage, budgets and cost estimates, not an admin screen |
| B1.11 | deployments (admin) | blocked (decision): the page shows platform releases (promote to staging/production) while platform-api only acts on tenant deployments and cannot list them |
| B2.1 | marketplace-admin: the governance queue (listings in review, draft/blocked tools) with approve, reject (send back) and take down, each with a recorded reason; "needs changes" has no API action and is hidden in live | done (this PR) |
| B2.2 | billing-ops: cross-tenant list of tenants out of good standing (dunning grace/limited/suspended) via a SECURITY DEFINER function; resolve, credit and retry have no backend and are hidden in live | done (this PR) |
| B2.3 | checkout | todo |
| B2.4 | KYC review, staff side: queue of pending seller verifications across tenants (Operations pool) and approve/reject (reason required) as the staff member, audited, in the admin Marketplace page. Removed the interim route, which only a dogfood tenant owner could call and which could only review that tenant's own submission. Seller-side document upload is blocked (below). | done (this PR) |
| B2.5 | tax / fee settlement | todo |
| B2.6 | tokenized card setup | todo |
| B2.7 | invoice PDF: Razorpay renders the invoice; its hosted page (`short_url`, view and PDF download) is carried through as `documentUrl` (https only) and linked from the invoices page | done (this PR) |
| B2.8 | new subscription: with no subscription and a registered payment method, the plans page subscribes through `POST /api/v1/billing/subscription` (idempotent). In live mode a tenant has no payment method until B2.6 is decided, so this path is wired but not reachable there yet | done (this PR) |
| B2.9a | usage and cost pages live: month-to-date billable spend and billed operations, by source and by provider/resource, from `/api/v1/costs/summary`. Live mode showed the demo's made-up figures before (e.g. "$284.73", random chart bars). Workflow/project estimates now show "-" in live instead of invented numbers. Budgets hidden in live until B2.9b. | done (this PR) |
| B2.9b | budgets: platform_db `budgets` (migration 0024, tenant RLS, per workspace, monthly, INR/USD, notify/warn/block thresholds) with list (any member; this month's billable spend from the cost ledger, unknown if the ledger is down or counts another currency), create/update/delete (workspace admin, new `budgets:write`). Page creates, pauses, deletes. Thresholds are stored, not yet acted on: alerts wait on B3.1, blocking on C10 | done (this PR) |
| B3.1a | notifications in the console, live: centre, bell and preferences over `/api/v1/notifications` (six event classes mapped to the console's categories, in-app and email per class, links kept only when in-app). "Mark unread" has no API and is hidden. The digest and connector-health jobs' cross-tenant pools (`NOTIFICATION_DIGEST_SYSTEM_DATABASE_URL`, `CONNECTOR_HEALTH_SWEEP_SYSTEM_DATABASE_URL`) were configured nowhere, so both jobs failed closed; the EC2 kit now points them at `platform_operations` | done (this PR) |
| B3.1b | notification producers. **Connection health (this PR):** when a connection turns unhealthy (on a user's check or the health sweep), every workspace admin gets one `system` warning with a link to the connection -- once on the transition, not on every sweep, and a failed notification never fails the check (design log §4 bucket 3). Recipients are read through tenant RLS. **Blocked (decision: system principal):** run-failure, approval-requested, self-heal and deployment events all start in the engine, and platform-api can read the engine only as a signed-in user; budget thresholds need the same to read the cost ledger. **Found:** no SES template (`notification-<class>`) is provisioned anywhere, so notification email fails on SES until 6.1b adds them | partly done (this PR) |
| B3.2 | benchmarks | blocked (decision, below): the console is customer-facing, but eval_db holds only Alter's own golden sets and the API only runs them for staff |
| B3.3 | discovery live: suggestions derived from the workspace's own runs, documents, approvals and connectors, with "Create draft workflow" (opens the new draft) and Dismiss. The use-case catalogue keeps only conversation starters in live; the demo's template ids and invented recommendations are not shown | done (this PR) |
| B3.4 | server search beyond listing/tool: the engine's workflow and project lists take `q` (case-insensitive name match, `%`/`_`/`\` literal, still paged, 1-200 chars), platform-api forwards it, and the spotlight asks the engine instead of filtering the first page of 50 in the browser. Knowledge sources and connections stay client-side (short per-workspace lists) | done (this PR) |
| B3.5 | Tool Registry confirmed live 2026-09-28: a real platform-api process (dev mode, mock sign-in) on real Postgres and LocalStack listed, created a manifest and version, scanned, read the report and revoked (version `revoked`). The scan verdict is honestly `unavailable`: no package scanner is wired (decision below) | done |
| B3.6 | Media Services: routes confirmed live on the same process with the mock providers (image, speech, transcript). A run against the real Titan/Polly/Transcribe costs cents and waits for your OK; on EC2 the kit selects the real providers (6.1d) | partly done (real-provider run needs your OK) |

Each B item: backend route exists and is wired, `isLiveApi` path added, the live-mode hide
policy from #212 lifted for it only when its live adapter is verified.

### Track C — design-log compatibility
| # | Item | Status |
|---|---|---|
| C29 | slice 2b: each compiled node's own success criteria reach the node that produces the output (LLMTask states them) and the Verification & Quality Gate, which judges each one and fails the node on any unmet criterion whatever the rubric score. Live Bedrock proof of an off-contract answer failing still to run | done (this PR) |
| C1 | 11 AST architecture gates imported from alterengine--5 into `scripts/gates/`, run in CI against `baseline.json` (722 findings recorded): a new violation fails and so does a fixed one left in the baseline, so the count only ratchets down. Adapted: Cost Ledger paths, generated code skipped, and the two gates whose subject does not exist yet (deletion registry, capability registry) report that single absence instead of crashing | done (this PR) |
| C3 | deletion registration in CI: `packages/deletion-registry` names all 125 tables in the 8 databases -- 100 tenant tables with the erasure route that reaches them, 25 exemptions with reasons. CI builds every database from its real migrations (`scripts/deletion/materialize-schemas.sh`, pgvector Postgres) and `certify.ts` fails on an unregistered or stale table, on a provider that erases a different set than the registry says, or on more erasure gaps than `MAX_ERASURE_GAPS`. The source gate's 174 findings fall to 0. **Found: erasure reaches 38 tenant tables; 62 are gaps** (platform_db 49, cost 3, intelligence 5, policy 4, audit 1) | done (this PR) |
| C3b | erasure providers for the gaps: platform-api, cost-ledger-service, intelligence-service and memory-service providers wired into the audit-service DeletionOrchestrator; lower `MAX_ERASURE_GAPS` with each. Retention rules first (decision below) | todo |
| C5 | cost ledger records verification verdicts | blocked (freeze exemption): changes the Cost Ledger (Category 1 #22) and the run-completion path that would feed it verdicts |
| C8 | side-effect ledger and idempotency gate before Dispatch | blocked (freeze exemption): a gate in front of Dispatch sits in the Executor (Category 1 #6) |
| C10 | Run Manager atomic budget gate | blocked (freeze exemption): Run Manager is Category 1 #1 |
| C9 | reviewer isolation: already in place (ENGINE-FIX-P3-15: output classified for injection before review, passed as labelled untrusted data, a detected attempt fails without review). The divergence was fail-open: a failed or unreadable classifier answered "not detected", so an outage let unscreened output reach the reviewer. It now raises like a failed review, leaving the node unverified (§5.5, planes 37) | done (this PR) |
| C11 | Policy Store global tier | blocked (freeze exemption): Policy Store is Category 1 #18 |
| C36 | §5.2 mechanical read-back | blocked (freeze exemption): Verification & Quality Gate (#17) |
| C37 | §5.3 end-of-run holistic check | blocked (freeze exemption): Verification & Quality Gate (#17) and Synthesis (#19) |
| C38 | §19 Capability Registry workflow templates | blocked (freeze exemption): Capability Registry is Category 1 #20 |
| C39 | §17 Drift Detector outbound suggestion path | blocked (decision: system principal): the suggestion must reach the user, and the only delivery path, platform notifications, cannot be fed by an engine service until that decision is made (B3.1b) |
| C4 | safety as a shared in-process library | blocked (freeze exemption): moving the screens out of Conversation Manager (#23) and Model Gateway (#15) into one library changes both |
| C7 | Agent Factory extracted: the Factory no longer imports Selection & Binding. What both need -- the embedding port and vector check, the id types, `NoAgentMatch` -- moved to a neutral `src/agent_contracts` (Selection re-exports, so nothing else changed); a boundary test fails if the Factory imports Selection or Recovery again. Behaviour unchanged: 366 intelligence tests pass | done (this PR) |
| C18 | re-embed backfill | blocked (freeze exemption): rewrites the Capability Registry's (#20) stored vectors |
| C13 | map 54 contracts onto 61 components: 44 component READMEs now carry their contract's blast radius, fail mode and driver (some map to two contracts, e.g. HumanApproval to Node Type Registry and Approval Store); the 17 no contract covers say so and keep proposed values | done (this PR) |
| C33 | deterministic wait in the flaky Temporal test: the rollover test waits on the first run's own result without following the chain (settles exactly at continue-as-new) instead of a 10 s wall-clock poll | done (#31, which it blocked) |
| C34 | specs authorize through the enforcing resolver: `enforcing-rbac.routes.spec.ts` mounts the real Project and Workflow controllers behind the production resolution rules and proves the admin of workspace A is refused B's project and workflow (403, only the ownership lookup reaches the engine); removing the workflow binding fails it | done (this PR) |
| C35 | vitest hang with `.env.local` present: Vite 8's `loadEnv` (bundled dotenv-expand) loops forever on `PLATFORM_DB_PORT=${PLATFORM_DB_PORT:-5432}` once `DATABASE_URL` references it. Every Vitest config, plus a new root one for config-less runs, sets `envDir: false`; CI runs a spec with a generated `.env.local` under a 120 s timeout | done (this PR) |
| C40 | §4 a safety violation halts the whole workflow before Recovery: output the gate blocks as a prompt injection now raises SafetyViolationError (code SAFETY_VIOLATION), Recovery is not triggered, the Nodeexec transport marks it FAILED_PRECONDITION with a SAFETY_VIOLATION prefix, the activity turns it into a non-retryable SafetyViolation failure, and the Executor fails the workflow at once (SafetyViolationHaltError) without waiting for a recovery decision. Previously Recovery routed safety_violation to ask_user and the run waited | done (this PR) |
| C41 | §4 pre-compile live-connection check and batch connector ask (D-4g) | blocked (design decision): the engine holds tool credentials in Tool Gateway while users connect accounts in platform-api (`oauth_connections`), two stores with no mapping from a capability to either; and the check belongs in the compile path, which is frozen (Category 1). Needs a decision on which store is authoritative |
| C42 | §8 pre-flight advisory on manual overrides and goal-change prompt (D-8a) | blocked: the canvas has no per-node model/tool override to advise on yet, and the materiality threshold is a product call |
| C43 | §9 always-on pre-run cost estimate (D-9b) | blocked (decision): cost events carry `run_id` but no workflow, and the ledger answers only month summaries and explicit line items. Choose the method: historical average of the workflow's verified runs (needs a per-run ledger query, Cost Ledger is frozen) or a per-node token model (needs assumed token counts, which §5.5 forbids inventing) |
| C44 | §12 cache answers only an exact repeat (C17 implemented): Model Gateway keys entries by tenant and a hash of the scope plus the caller's own content, through getValue/setValue, with no embedding call on lookup; the eval bootstraps never read the cache. Old code served "Classify the risk of the Apex contract" with Acme's cached answer | done (this PR) |
| C45 | §18 user-configurable run-history retention, 7 days to 1 year, destructive lowering confirmed (D-18c) | blocked (C3 retention decision) |
| C46 | §30 explicit refusal and audit for service-asserted tenants (D-30a/b; mismatch answers run-not-found, nothing audited) | blocked (freeze check): run-learning read path, Run Manager (#1) |
| C47 | §31 tier ceiling default `STANDARD` (D-31a; main had `ADVANCED` though memoryalter recorded the change) | done (PR #46) |
| C30 | §16 approval modes | blocked (decision) |
| C32 | image publishing collision | blocked (decision) |

### Track D — design-log conformance (last)
| # | Item | Status |
|---|---|---|
| D1 | whole log against whole system, incl. rules adopted from alter-x-4-: all 33 sections and `planes.md` against main, in `docs/conformance/design-log-conformance.md` -- 9 conform, 13 conform with divergences, 10 diverge | done (this PR) |
| D2 | record every divergence before fixing: 38 recorded (D-2a to D-32a), each ending in code, amend log, or decision; 7 new board items C40-C46 | done (this PR) |
| D3 | allow "amend the log" as a conclusion: 4 amendments proposed (§4, §7, §23, §32) and 6 build-or-amend choices, all awaiting Havish; the log itself is not edited until he accepts | done (this PR) |

## Blocked on a decision or an account — asked at the end

| Item | What is needed from Havish |
|---|---|
| 6.1b | Auth0 tenant (API, M2M app, customer regular web app), SES verified domain out of sandbox + sending key, Bedrock Titan image access, EC2 size and monthly cost approval, domain for HTTPS |
| 6.2b | Temporal Cloud account and API key in Secrets Manager |
| 5.2 live proof | GitHub OAuth app, client id/secret in Secrets Manager |
| B1 live proof | A staff Auth0 tenant with a PKCE app (callback `<origin>/staff/callback`), and each staff member added to `staff_users` |
| C30 | Build §16's four approval modes, or amend §16; plus open question 8 (notification channel) |
| Freeze exemptions (Track C) | The 2026-09-07 freeze ("no code change to the 25 Category 1 components") still stands; the C29 exemption covered C29 only. Ten Track C items change a Category 1 component and wait on an exemption like C29's: C5 Cost Ledger; C8 Executor; C10 Run Manager; C9, C36 Verification & Quality Gate; C37 Gate + Synthesis; C11 Policy Store; C4 Conversation Manager + Model Gateway; C18, C38 Capability Registry. Grant per item (recorded in memoryalter before code), all, or none? |
| C32 | Grant this repository write on the GHCR packages, rename our images, or turn `images` publishing off here |
| B1.11 | Admin deployments page: build a platform-release view (over the promotion gate and release evidence), or re-scope the page to tenant deployment actions (rollback/suspend/resume), which need a list route? |
| B1.8 gap | Assigning a security review to a staff member has no backend (hidden in live). Build or drop? |
| B1.6/B1.7 gaps | Provider "maintenance" state and editing policies from the list page have no backend (hidden in live). Build or drop? |
| B1.2 gaps | Admin user screens show MFA and risk state in demo only; user notes (write) have no backend. Build or drop? |
| Cost visibility | `GET /api/v1/costs/summary` returns the ledger's internal cost and margin to any workspace member with billing:read. The console shows only billable spend, but the API still exposes them. Recommendation: strip internal/retry/recovery cost and margin from the tenant route, and keep them for a staff route. Confirm? |
| B2.4 upload | Sellers cannot submit identity documents in live mode: there is no document store and no KYC vendor ("manual review until a vendor is selected"). Choose: Razorpay Route linked-account KYC (Razorpay holds the documents), a vendor, or our own encrypted S3 store with retention rules. |
| B3.2 | Benchmarking console: customers see a benchmarks area, but the engine has no tenant datasets or tenant eval runs (eval_db = Alter's golden sets; `/api/v1/admin/benchmarks` = staff run + release gate). Choose: (a) staff-only eval history in the admin console (needs a list-runs RPC), (b) build tenant datasets and runs in eval-service, (c) drop from v1. Recommendation: (a) now, (b) later. |
| B3.5 scanner | No package scanner is wired, so every tool version scans `unavailable` and none can be verified clean. Choose a scanner (e.g. OSV/Socket/Snyk) or keep manual review. |
| B3.6 real run | OK to spend a few cents running image, speech and transcription once against the real AWS providers (Titan, Polly, Transcribe) from this machine? |
| C3 retention | Erasure currently misses 62 tenant tables. Design log §18 already settles audit events (minimised to an event skeleton, then destroyed after a 30- or 90-day window) and member erasure (pseudonymise). Still open before providers are built: **which window, 30 or 90 days**; and what law requires kept longer after a tenant deletion -- billing and invoice records (tax), payouts and KYC (financial regulation), staff access records. Everything else is destroyed immediately (§18). |
| B2.1 gap | Marketplace "needs changes" and a risk score have no backend (hidden in live). Build or drop? |
| B2.2 gaps | Billing ops resolve/dismiss, apply credit and retry charge have no backend (hidden in live), and the dunning state records no amount. Build (needs Razorpay retry/credit calls) or drop? |
| B1.1 gaps | Admin tenant screens show members, workflows, 30-day runs and spend in demo only; tenant notes (write) and a "restricted" tenant state have no backend. Build them, or drop them from the UI? |
| Log amendments (D3) | Accept or reject each: §4 buckets become the code's ten failure classes with their mapping to the five, and "retry once, then swap" for a repeated transient failure; §7 pattern 1 is enforced by the mock-reachability gate and `RUNTIME_MODE`, not a marker type; §23 Project Mode code is present but not offered in v1; §32 closed by deleting the columns (2026-09-14). |
| §5.1 criteria | Success criteria are inferred by the model and never shown to the user. Add a step where the user sees, edits and confirms them, or amend §5.1 to "inferred, shown and editable"? |
| §9 budget scope | Budgets are per workspace, monthly. §9 says per workflow, daily or monthly. Add per-workflow and daily, or amend §9? |
| §10 folders | No "Ungrouped" bucket and no folders of workflow sessions. Are engine projects the folders, or build folders? |
| §15 roles | Fixed roles over 27 route-derived permissions, no custom roles. Build custom roles over a closed toggle set, or amend §15 to fixed roles? |
| §25 public form | No hosted public form; public inbound is webhooks only. Build the lead-capture form (§1's own example) for v1, or amend §25 to webhooks-only in v1? |
| §26 rename | "Session Gateway" survives in 61 files including `packages/auth`. One mechanical rename (touches frozen components and contracts), or amend §26 to "renamed when touched"? |
| System principal | Engine-originated notifications (run failed, approval waiting, self-heal happened, deployment changed) and budget alerts need platform-api to read the engine and cost ledger with no user signed in. Options: (a) a platform-jobs service identity the engine accepts with an explicit tenant, per design log §30 (recommended: the pattern is already locked and the memory service uses it), or (b) the engine pushes events to platform-api over an internal endpoint (touches frozen Executor/Run Manager). |
