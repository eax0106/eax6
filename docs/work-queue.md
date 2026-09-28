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
| B3.1b | notification producers: nothing in the system calls `createEvent`, so the centre stays empty. Emit approval-requested (to approvers), budget thresholds (to workspace admins; also B2.9b's alerts), deployment and run-failure events | todo |
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
| C29 | slice 2b: criteria to the producing node and the gate | todo |
| C1 | 11 AST architecture gates with a baseline | todo |
| C3 | deletion registration in CI | todo |
| C5 | cost ledger records verification verdicts | todo |
| C8 | side-effect ledger and idempotency gate before Dispatch | todo |
| C10 | Run Manager atomic budget gate | todo |
| C9 | reviewer isolation against prompt injection | todo |
| C11 | Policy Store global tier | todo |
| C36 | §5.2 mechanical read-back (no board item until now) | todo |
| C37 | §5.3 end-of-run holistic check (no board item until now) | todo |
| C38 | §19 Capability Registry workflow templates (no board item until now) | todo |
| C39 | §17 Drift Detector outbound suggestion path (no board item until now) | todo |
| C4 | safety as a shared in-process library | todo |
| C7 | Agent Factory extracted | todo |
| C18 | re-embed backfill | todo |
| C13 | map 54 contracts onto 61 components | todo |
| C33 | deterministic wait in the flaky Temporal test: the rollover test waits on the first run's own result without following the chain (settles exactly at continue-as-new) instead of a 10 s wall-clock poll | done (#31, which it blocked) |
| C34 | specs authorize through the enforcing resolver | todo |
| C35 | vitest hang with `.env.local` present | todo |
| C30 | §16 approval modes | blocked (decision) |
| C32 | image publishing collision | blocked (decision) |

### Track D — design-log conformance (last)
| # | Item | Status |
|---|---|---|
| D1 | whole log against whole system, incl. rules adopted from alter-x-4- | todo |
| D2 | record every divergence before fixing | todo |
| D3 | allow "amend the log" as a conclusion | todo |

## Blocked on a decision or an account — asked at the end

| Item | What is needed from Havish |
|---|---|
| 6.1b | Auth0 tenant (API, M2M app, customer regular web app), SES verified domain out of sandbox + sending key, Bedrock Titan image access, EC2 size and monthly cost approval, domain for HTTPS |
| 6.2b | Temporal Cloud account and API key in Secrets Manager |
| 5.2 live proof | GitHub OAuth app, client id/secret in Secrets Manager |
| B1 live proof | A staff Auth0 tenant with a PKCE app (callback `<origin>/staff/callback`), and each staff member added to `staff_users` |
| C30 | Build §16's four approval modes, or amend §16; plus open question 8 (notification channel) |
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
| B2.1 gap | Marketplace "needs changes" and a risk score have no backend (hidden in live). Build or drop? |
| B2.2 gaps | Billing ops resolve/dismiss, apply credit and retry charge have no backend (hidden in live), and the dunning state records no amount. Build (needs Razorpay retry/credit calls) or drop? |
| B1.1 gaps | Admin tenant screens show members, workflows, 30-day runs and spend in demo only; tenant notes (write) and a "restricted" tenant state have no backend. Build them, or drop them from the UI? |
