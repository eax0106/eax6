# Alter Platform — Architecture Documentation

**Version:** 1.0
**Date:** 2026-07-22
**Status:** Authoritative source of truth for the Alter Platform pillar. Companion to the Alter Engine Tech Spec (03), Data Model (04), API Spec (05), Env & Config (07), Test Plan (08), Deploy Checklist (09). Supersedes the original 48-item candidate feature list. Does **not** contain the phase-by-phase build plan (produced separately after this document).

---

# Part 1 — Platform Definition

**Alter Platform is the complete user-facing product, interaction layer, operational control plane, and ecosystem layer through which users access Alter.** It is a Tier-1, globally scalable, enterprise-grade product — not a dashboard, not a thin Engine wrapper, not an MVP shell. It competes with and is designed to outperform n8n, Zapier, Make, Lovable, Bolt, Replit, Lindy, Relevance AI, and Dust.

**Platform owns:** user experience; workflow and project creation (conversational + visual); execution visibility; approvals and human intervention; integrations and connectors; knowledge management experience (over ADS); deployment management; cost visibility and billing; marketplace and ecosystem; tenant/workspace administration; notifications; platform observability surfaces; the Alter CLI.

**Platform does not own:** planning, binding, compilation, execution, verification, recovery, or learning (Engine); knowledge storage and retrieval mechanics (ADS / ADS Q); secret material (Secrets Provider); vendor infrastructure (behind adapters).

**Relationships:**

- **Alter Engine** — headless execution system. Platform communicates only through private, versioned Engine APIs (REST/OpenAPI 3.1.1 + SSE per API Spec). Browser never reaches Engine directly.
- **ADS / ADS Q** — ADS (Altered Data Storage System) stores tenant knowledge; ADS Q is the controlled query/retrieval layer. Platform provides the management and observability experience over both via approved APIs; it never performs direct vector retrieval. The legacy term "Brain Engine" is permanently retired.
- **External providers** — every vendor sits behind an Alter-owned adapter interface (Part 14). Providers are replaceable defaults, never architectural dependencies.
- **Two modes** — Workflow Mode (create/run/maintain intelligent business workflows; conversational generation + manual no-code canvas) and Project Mode (build/test/audit/deploy/maintain complete software). Shared foundations, mode-specific experiences.
- **Customer workspace** — tenant → workspace → workflow/project hierarchy (Part 8).
- **Admin & Operator Plane** — separate Alter-internal control plane; staff are never members of customer tenants; JIT scoped support access only.

**Access model (v1):** public self-service signup (email/password + Google) with free tier, plus Alter-managed enterprise tenants. Paid marketplace live. All capabilities operational by August 2, 2026; v1.x expands scale and provider breadth, never introduces missing core features.

---

# Part 2 — Final Feature Index

Status legend: **R** retained · **RN** renamed · **M** merged · **S** split · **N** new · **X** removed. Mode: Sh shared · W Workflow · P Project · A admin/operator.

| # | Final Feature | Status | Origin | Mode | Owning Component | Visibility |
|---|---|---|---|---|---|---|
| F1 | Visual Workflow Canvas | R | A1 | W | Workflow Studio | customer |
| F2 | Run Inspector & Developer Studio | M | A2+A4 | Sh | Run Experience | customer |
| F3 | Embedded Terminal Panel | S | A3 | Sh | Run Experience | customer |
| F4 | Alter CLI / TUI | S | A3 | Sh | CLI Client | customer |
| F5 | Visual Data Mapping Editor | R | A5 | W | Workflow Studio | customer |
| F6 | Automated Use-Case Discovery | R | A6 | Sh | Discovery Service | customer |
| F7 | Agent Library (Agent Store) | R | B7 | Sh | Marketplace Service | customer |
| F8 | Template Store | R | B8 | Sh | Marketplace Service | customer |
| F9 | Public Marketplace (paid, 80/20) | R | B9 | Sh | Marketplace Service | customer |
| F10 | Seller Console & Payouts | N | — | Sh | Publisher & Payout Service | customer |
| F11 | Marketplace Governance & Moderation | N | B9/21 | A | Admin Console | admin |
| F12 | Knowledge Sources & Upload | M | B10+B11 | Sh | Knowledge Management | customer |
| F13 | Ingestion & Indexing Visibility | M | B11+F45 | Sh | Knowledge Management | customer |
| F14 | Retrieval Configuration & Testing | M | B12+F45 | Sh | Knowledge Management | customer |
| F15 | Multi-Platform Deployment | R | C13 | P | Deployment Manager | customer |
| F16 | Intelligent Deployment Routing | R | C14 | P | Deployment Manager | customer |
| F17 | Post-Deployment Health Monitoring | R | C15 | P | Deployment Manager | customer |
| F18 | Repository Management (Git) | M | C16+C17 | P | Repository Manager | customer |
| F19 | Connector Catalog & SaaS Integrations | M | C20+C18+C19 | Sh | Integration Hub | customer |
| F20 | Community Tool Registry (MCP/tools) | R | C21 | Sh | Tool Registry | customer |
| F21 | Trigger Management (webhooks + schedules) | M | C22+E26 | W | Trigger Management | customer |
| F22 | Image Generation Access | Removed 12 October 2026 | — | — | — | — |
| F23 | Text-to-Speech | Removed 12 October 2026 | — | — | — | — |
| F24 | Speech-to-Text | Removed 12 October 2026 | — | — | — | — |
| F25 | Email Notifications | R | E27 | Sh | Notification Service | customer |
| F26 | In-App Notification Centre | R | E28 | Sh | Notification Service | customer |
| F27 | Authentication, RBAC & Enterprise SSO | R | E29 | Sh | Identity & Session | customer |
| F28 | Dynamic Template Variables | R | E31 | Sh | Workflow/Project Studio | customer |
| F29 | Credential Vault (references) | R | E32 | Sh | Credential Vault UI | customer |
| F30 | Pre-Execution Cost Estimation | R | E33 | Sh | Cost & Billing Experience | customer |
| F31 | Spending Dashboard & Budgets | R | E34 | Sh | Cost & Billing Experience | customer |
| F32 | Human Action Centre | R | F35 | Sh | Human Action Centre | customer |
| F33 | Memory Configuration | R | F36 | Sh | Knowledge Management | customer |
| F34 | Model & Escalation Settings | R | F37 | Sh | Settings/Policy UI | customer |
| F35 | Unified Command Experience | RN | F38 | Sh | Command & Chat | customer |
| F36 | WhatsApp Channel Management | R | F40 | W | Communication Channels | customer |
| F37 | Voice Channel Management | R | F41 | W | Communication Channels | customer |
| F38 | Agent Benchmarking Console | R | F48 | Sh | Benchmarking Console | customer/admin |
| F39 | Workflow Simulation & Activation | N | — | W | Workflow Studio | customer |
| F40 | Project Build Experience (live build, file tree, code view, tests, audit, preview) | N | prompt Part 10 | P | Project Studio | customer |
| F41 | Onboarding & First-Run Experience | N | gap | Sh | Identity & Session + Growth | customer |
| F42 | Self-Serve Billing & Subscriptions | N | gap | Sh | Cost & Billing Experience | customer |
| F43 | Abuse & Fraud Controls | N | gap | A | Admin Console | admin |
| F44 | Support Access Consent & Audit View | N | gap | Sh/A | Admin Console + Settings | both |
| F45 | Localization (EN + HI v1) | N | gap | Sh | Localization | customer |
| F46 | Global Search | N | gap | Sh | Search Service | customer |
| F47 | Data Export & Right-to-Delete UI | N | gap | Sh | Settings / Governance UI | customer |
| F48 | Admin & Operator Consoles | N | prompt Part 4 | A | Admin Console | admin |

**Removed / re-homed from original 48:** #30 multi-tenant isolation → cross-cutting law, not a feature. #38 renamed to Unified Command Experience. #39 "Brain Engine" → removed as a name; capability = ADS/ADS Q management (F13–F14) + analytics routing inside Engine. #42 Next.js evaluation → architecture decision (Part 15). #43 Inngest → rejected; capability delivered by Platform Jobs on Temporal (internal, Part 5). #44 object storage, #46 pluggable backends → infrastructure/cross-cutting. #18/#19 LinkedIn/X → connectors inside F19, not standalone features.

**Final count: 48 features** (coincidentally 48 again — different composition).

---

# Part 3 — Platform Component Index (logical components)

One feature ≠ one component; one component ≠ one deployable. 22 logical components + shared systems.

| # | Component | Responsibility | Key Features | Stored State | Consumes / Produces |
|---|---|---|---|---|---|
| C1 | Identity & Session Manager | Auth0 integration, sessions, SSO, actor-token issuance (Identity Broker), device/session management, signup + free-tier provisioning | F27, F41 | sessions, identity refs | IdentityProvider; → actor tokens |
| C2 | Tenancy & Entitlement Service | tenants, workspaces, memberships, roles, plans, entitlements, free-tier limits | F27, F42 | platform_db tenancy tables, entitlements | EntitlementProvider, billing events |
| C3 | Workflow Studio | canvas (React Flow), creation chat, data mapping editor, template variables, versions UI, simulation/activation controls | F1, F5, F28, F39 | draft DAGs (`metadata.ui.*`), canvas prefs | Engine workflow APIs, Node Registry API |
| C4 | Node Palette Sync | mirrors Engine Node Type Registry, adds presentation metadata only | F1 | palette presentation metadata | Engine registry API |
| C5 | Run Experience | run timeline, node inspector, message-flow view, embedded terminal, recovery history | F2, F3 | view prefs, stream cursors (cache) | Engine SSE + run APIs |
| C6 | Human Action Centre | approvals, clarifications, escalations, manual decisions, resumption | F32 | ack state, assignment | Engine approvals/clarifications APIs |
| C7 | Project Studio | brief, clarification, plan review, live build, file tree, code view, tests, audit results, preview | F40 | UI state, review annotations | Engine project/build APIs, Repository Manager |
| C8 | Deployment Manager | multi-provider deploys, intelligent routing, health monitoring, rollback UX | F15–F17 | deployment display state | DeploymentProvider, Engine deployments API |
| C9 | Repository Manager | GitHub App/OAuth, repo binding, branch/PR visibility, transfer | F18 | repo bindings (refs) | RepositoryProvider |
| C10 | Knowledge Management | ADS sources, uploads, ingestion status, retrieval config/testing, memory config, provenance, deletion | F12–F14, F33 | none (ADS-owned); view state | ADS admin/ingestion APIs |
| C11 | Integration Hub | connector catalog, SaaS connections (HubSpot, Salesforce, Slack, Shopify, LinkedIn, X, …), connection health | F19 | integration records, credential refs | ConnectorProvider, Secrets refs |
| C12 | Credential Vault UI | credential reference management, masking, permissions | F29 | credential references only | SecretsProvider (refs) |
| C13 | Trigger Management | webhook endpoint config/testing, schedules, trigger versions UI | F21 | none (Engine-owned triggers); UI state | Engine trigger APIs, Event Gateway ingress info |
| C14 | Marketplace Service | listings, search, install, purchase, licensing, ratings/reviews, versioning | F7–F9 | marketplace_db listings, orders, reviews | BillingProvider, Search |
| C15 | Publisher & Payout Service | seller verification/KYC, publishing pipeline states, revenue share, payouts | F10 | publisher records, payout ledger refs | MarketplacePayoutProvider (Razorpay Route/Stripe Connect) |
| C16 | Community Tool Registry | tool/MCP manifests, trust levels, capability declarations, scanning, revocation | F20 | registry entries, scan results | sandbox-exec runtime, Admin review |
| C17 | Notification Service | in-app centre, email, preferences, severity, deep links, escalation | F25–F26 | notifications, prefs | NotificationProvider, EmailProvider |
| C18 | Cost & Billing Experience | estimation, spending dashboards, budgets, subscriptions, invoices | F30–F31, F42 | budget configs; billing refs | Engine cost APIs, BillingProvider |
| C19 | Discovery Service | use-case discovery over authorised data, recommendations w/ evidence + scoring | F6 | recommendations | ADS Q (via Engine/API), run history APIs |
| C20 | Media Services | Removed by owner 12 October 2026 | — | — | — |
| C21 | Communication Channels | WhatsApp account/templates/testing/monitoring; voice channel config | F36–F37 | channel configs | TelephonyProvider, connector APIs, Event Gateway |
| C22 | Benchmarking Console | agent/model comparisons, eval history, promote/rollback views | F38 | none (eval_db-owned); view state | Engine eval APIs |
| C23 | Admin & Operator Console | tenant admin, support access, provider mgmt, incidents, policy, billing ops, abuse review, audit explorer, marketplace governance | F11, F43, F44, F48 | admin plane data | audit APIs, all domain services |
| C24 | Platform Jobs | Temporal `platform` namespace: ingestion coordination, exports, marketplace review, notification fan-out, syncs, cleanup | internal | job state (Temporal) | DurableJobProvider |
| C25 | Streaming Gateway | SSE fan-out to browser, resume, auth revalidation | internal | stream cursors (Redis) | Engine SSE, WebSocket-future |
| C26 | Search Service | global + marketplace search behind SearchProvider | F46 | search indexes (Postgres FTS) | SearchProvider |
| C27 | Localization | EN+HI bundles, locale routing, formatting | F45 | translation bundles | — |

Shared systems (not components): Design System (Part 11), Contract Plane (`packages/contracts`), Feature Flags (AppConfig), Observability Plane, Security & Governance Plane, Provider Adapter Layer.

Every component: tenant-scoped state, RLS-backed where persisted, per-component scaling profile, graceful degradation defined in Part 18.

---

# Part 4 — Platform Surface Inventory

Every surface must define all six states: **loading** (skeletons, no layout shift), **empty** (guided CTA), **error** (RFC 9457-mapped message + retry), **degraded** (partial data flagged, stale timestamps), **permission-denied** (explains role needed, no data leak), **success**. These state requirements are global and are not repeated per row.

**Shared surfaces (16):** Sign in/Sign up · Onboarding wizard (mode intro, first workflow/project, free-tier explainer) · Home dashboard (runs, actions pending, costs, health) · Workspace switcher · Unified Command & Chat (goal input, global command palette, mode routing) · Notification Centre · Human Action Centre (approvals/clarifications/escalations queues) · Run History (cross-mode) · Artifacts browser · Cost & Usage (estimation, dashboards, budgets) · Integrations (catalog + connections + health) · Knowledge (sources, ingestion, retrieval test, memory config) · Members & Roles · Settings (tenant/workspace/profile/security/language/billing) · Audit view (customer-scope) · System status embed.

**Workflow Mode surfaces (15):** Workflow list · Creation chat · Visual canvas builder · Workflow review (generated-DAG diff vs edits) · Trigger configuration · Integration mapping · Data mapping editor · Simulation (dry-run w/ test events) · Activation & environment promotion · Run timeline · Node inspector (I/O, verification, cost per node) · Recovery history · Versions & rollback · Workflow health (VACR, error classes) · Template publishing flow.

**Project Mode surfaces (18):** Project list · Creation brief · Requirements clarification · Architecture/plan review · Build progress (live waves) · File tree · Code-change view (diffs, Monaco) · Terminal/log stream · Test results · Code audit report · Preview (embedded + link) · Render verification results · Deployment (provider, routing recommendation, promote) · Repository view (branches, PRs, sync) · Environment variables (refs, masked) · Project versions · Maintenance (change requests, dependency updates) · Handoff (docs, ownership, export).

**Marketplace surfaces (7):** Marketplace home/browse/search · Listing detail (permissions requested, trust level, reviews) · Install/purchase flow · Seller console (KYC, listings, versions, earnings, payouts) · Publish pipeline (draft→review→published states) · My assets (installed, licenses, updates) · Reviews & ratings.

**Admin & operator surfaces (12):** Tenant administration · Support access (JIT grants, reason codes) · Provider management (health, activation, fallback) · System health · Incident management (+status-page publishing approval) · Evaluation management · Policy management (flags, entitlements, model policies) · Billing operations (plans, disputes, refunds) · Abuse & security review (fraud scores, free-tier abuse) · Audit explorer · Deployment administration · Marketplace governance (review queue, takedowns, trust levels).

**Total: 68 surfaces.**

---

# Part 5 — Platform Architecture Layers

```
1  Experience Layer            — pages, flows, modes (surfaces above)
2  Mode Experience Layer       — Workflow Studio / Project Studio specific UX
3  Design System               — tokens, components, primitives (Part 11)
4  Frontend Application Layer  — Next.js App Router (Vercel): rendering, RSC/client split,
                                 UI streaming, session, error boundaries
5  Backend-for-Frontend        — NestJS platform-api (Fargate): the ONLY caller of
                                 Engine / ADS / providers; RBAC; domain orchestration
6  Platform Domain Services    — components C1–C27 (inside platform-api + platform-workers)
7  Integration & Connector Layer — connector adapters, OAuth flows, channel providers
8  Knowledge Management Layer  — ADS admin/ingestion coordination (never retrieval mechanics)
9  Notification Layer          — in-app + email fan-out, preferences
10 Administration Layer        — admin console services, support access, governance
11 Streaming Layer             — SSE gateway, resume, fan-out
12 Background Layer            — Platform Jobs on Temporal `platform` namespace
13 Security & Governance Plane — authN/Z, tenancy, audit, deletion (cross-cutting)
14 Observability Plane         — OTel traces, Sentry, Core Web Vitals (cross-cutting)
15 Provider Adapter Layer      — every vendor behind Alter-owned interfaces (cross-cutting)
```

Hard rules: browser → Next.js → platform-api only. Next.js Server Actions delegate to platform-api; zero duplicated business logic. Third-party/marketplace code executes only in isolated runtimes (`alter-sandbox-exec`), never in layers 4–6.

---

# Part 6 — Connections Index

All synchronous connections carry `Authorization` (M2M) + `X-Alter-Actor-Token` + `traceparent`; all are tenant-scoped, observable, and RFC 9457 on error. Retry: idempotent GETs auto-retry with backoff; mutations retry only with `Idempotency-Key`.

| # | Source → Destination | Transport | Contract | Purpose | Sync |
|---|---|---|---|---|---|
| P1 | Browser → platform-web (Vercel) | HTTPS | Next.js routes | UI delivery | sync |
| P2 | platform-web → platform-api | HTTPS REST | OpenAPI 3.1.1 | all UI actions/data | sync |
| P3 | platform-web → Streaming Gateway | SSE | event envelope (seq, Last-Event-ID) | live updates | stream |
| P4 | platform-api → Engine | HTTPS REST `/api/v1` | Engine API Spec | workflows, projects, runs, triggers, approvals, costs, evals | sync |
| P5 | Streaming Gateway → Engine SSE | SSE | Engine stream contract | run/build progress relay | stream |
| P6 | platform-api → ADS admin/ingestion APIs | HTTPS/gRPC | ADS contracts | sources, uploads, jobs, deletion | sync |
| P7 | platform-api → Auth0 | OIDC | IdentityProvider | login, M2M, Organizations | sync |
| P8 | platform-api → Secrets Manager | SDK via SecretsProvider | ref-based | credential refs resolution | sync |
| P9 | platform-api → GitHub | GitHub App/OAuth via RepositoryProvider | repo ops | binding, PRs, sync | sync |
| P10 | platform-api → Vercel/Cloudflare/Netlify/Railway/AWS | DeploymentProvider | deploy ops | project deploys | sync+webhook |
| P11 | Deploy/GitHub/Connector webhooks → Event & Trigger Gateway | HTTPS webhook | canonical event | CI/deploy/channel feedback | async |
| P12 | platform-api → Razorpay/Stripe | BillingProvider / MarketplacePayoutProvider | subscriptions, orders, Route/Connect payouts | commerce | sync+webhook |
| P13 | platform-api → Exotel/Twilio | telephony provider interfaces | capability-based requests | channels | sync |
| P14 | platform-workers ↔ Temporal Cloud (`platform` ns) | Temporal SDK via DurableJobProvider | job workflows | background jobs | async |
| P15 | Platform Jobs → SES/email provider | EmailProvider | templated sends | email notifications | async |
| P16 | platform-api → cost/billing rollups | Engine cost APIs + billing_db | cost views, invoices | spend surfaces | sync |
| P17 | platform-api → Search (Postgres FTS) | SearchProvider | queries/indexing | marketplace + global search | sync |
| P18 | all services → OTel collector → Grafana Cloud; errors → Sentry | ObservabilityProvider | traces/metrics/logs | observability | async |
| P19 | platform-api → audit-service | gRPC/queue | audit events | tamper-evident audit | async |
| P20 | Admin Console → all domain services | internal REST | admin contracts | operations | sync |
| P21 | CLI → platform-api | HTTPS REST + SSE | same OpenAPI | thin-client parity | sync/stream |
| P22 | Marketplace scanning → sandbox-exec runtime | queue + isolated exec | scan jobs | malware/package scanning | async |
| P23 | AppConfig → platform-api/web | FeatureFlagProvider | flag evaluation | rollout control | sync (cached) |

**23 Platform connections** (Engine-internal wires 1–38 documented in Engine Tech Spec).

---

# Part 7 — Data & State Ownership

| State | Owner | Store |
|---|---|---|
| Tenants, workspaces, users, memberships, roles, entitlements, integrations (refs), budgets, feature-flag assignments | **Platform** (C2/C11) | platform_db |
| Marketplace listings, orders, licenses, reviews, publisher/KYC status, payout ledger refs, tool-registry entries, notifications, UI preferences, template metadata | **Platform** | marketplace_db + platform_db (new schemas, same ownership rules as Data Model doc) |
| Workflows, projects, versions, DAGs, triggers, runs, node executions, approvals, deployments (records), artifacts, run outcomes | **Engine** | orchestration_db — Platform reads via API only |
| Knowledge sources, documents, chunks, memory namespace, ingestion jobs, provenance | **ADS** | ADS cluster — Platform manages via APIs |
| Cost events, billing rollups | **Engine Cost Ledger + Platform billing** | cost_db + billing provider |
| Eval/benchmark data | **Engine eval-service** | eval_db — Platform reads |
| Audit events, support grants, deletion certificates | **audit-service** | audit_db |
| Secret material | **Secrets Provider** | Secrets Manager — Platform holds references only |
| Repos, deployments (live objects), payment objects | **Providers** | external — stored as refs |
| Stream cursors, session hot state, rate counters | cached | Redis (disposable) |
| Live run/build progress | streamed | SSE (never system of record) |
| Dashboards, health rollups, VACR displays | derived | computed projections, rebuildable |

Rule: Platform never writes Engine-owned or ADS-owned state directly; API/events only. Every persisted tenant-owned row: `tenant_id` + RLS per Data Model conventions.

---

# Part 8 — Tenancy & Permission Architecture

Hierarchy (per Engine spec): `Tenant → Workspace → {Workflow | Project}` (siblings) → versions → runs. Personal tenants created on self-service signup; enterprise tenants provisioned via admin plane.

**Roles:** Tenant: owner, admin, billing, member. Workspace: admin, editor (create/edit workflows & projects), operator (run/monitor/approve), approver (Human Action Centre decisions), viewer. Marketplace: publisher (verified tenants only), seller (KYC-complete publisher). Admin plane: platform-admin, support-agent, security-reviewer, marketplace-moderator, billing-ops — **never members of customer tenants**.

**Permission rules:** environment access gated per environment (production activation requires approver+); marketplace publishing requires tenant verification, paid publishing requires KYC + agreement; billing actions require billing/owner role; integration credential creation requires workspace admin; sharing = workspace-scoped, cross-workspace copy requires rights in both; every permission check server-side in platform-api (client flags never authorize); cross-tenant access structurally prevented (RLS + scoped repositories + CI leak tests); support access = JIT grant, scoped, reason-coded, time-limited, fully audited, customer-visible (F44).

---

# Part 9 — Workflow Mode Architecture (end-to-end)

```
Goal input (Command & Chat / workflow list)          → C3, Engine Conversation
→ Clarification (chat + Human Action Centre)         → C6
→ Workflow generation (Engine Planner → draft DAG)   → Engine
→ Visual review & editing (canvas, same DAG schema)  → C3, C4
→ Trigger + integration configuration                → C13, C11, C12
→ Data mapping                                       → C3 (mapping in node/edge config)
→ Simulation (dry-run, test events, mock external)   → C3 → Engine simulate API
→ Activation (env promotion, approval requirements)  → C3 → Engine activate
→ Live execution (event-driven runs)                 → Engine; visible via C5 (P3/P5)
→ Approval / escalation                              → C6
→ Result + monitoring (timeline, node inspector,
  recovery history, VACR health, costs)              → C5, C18
→ Maintenance (versions, rollback, edits → new
  immutable version, template publishing)            → C3, C14
```

Canvas law: one canonical WorkflowDAG schema; draft → validate → bind → compile → immutable executable version; Engine resolves protected runtime fields; palette = Engine Node Type Registry + Platform presentation metadata; `metadata.ui.*` ignored by runtime; full AI↔canvas round-trip.

---

# Part 10 — Project Mode Architecture (end-to-end)

```
Project brief                                        → C7
→ Clarification                                      → C7, C6
→ Plan/architecture review (user approves plan)      → C7
→ Repository creation (Alter org; customer org later)→ C9
→ Implementation (Engine build pipeline)             → Engine; live via C5/C7
→ Live build visibility (waves, file tree, diffs,
  terminal stream)                                   → C7, C5, C25
→ Testing (sandbox preflight results)                → C7
→ Code audit (independent agent report)              → C7
→ Repair loop                                        → Engine recovery; visible C5
→ Preview (Vercel preview + render verification)     → C8
→ Deployment (intelligent routing recommendation →
  user/provider confirm → deploy)                    → C8
→ Verification (post-deploy health, render checks)   → C8, F17
→ Handoff (docs, repo transfer option, export)       → C7, C9
→ Maintenance (change requests → new build cycle,
  dependency updates, monitoring)                    → C7, C8
```

Git = source of truth; deployment providers behind DeploymentProvider; intelligent routing scores project architecture, runtime needs, DB needs, geography, traffic, cost, preference — recommendation is explainable and overridable.

---

# Part 11 — Design System & UX Architecture

**Token architecture (owned here; visuals owned by UI/UX teammate):** layers `primitive → semantic → component → mode-specific → tenant override (future)`. Categories: color semantics, typography, spacing, sizing, borders, radius, elevation, motion, opacity, z-index, breakpoints, data-viz, status/severity, canvas/node, terminal, density modes. Examples: `color.status.failure`, `canvas.node.active.border`, `terminal.output.warning`, `motion.duration.fast`. No hardcoded colors/spacing/type in components. Themes: light, dark, system, high-contrast; tenant branding later.

**Component stack:** shadcn/ui foundation + Alter component library (StatusBadge, RunTimeline, NodeCard, DiffViewer, StreamingText, ApprovalCard, CostMeter, ProvenanceChip, TrustBadge…). Layout primitives: page shell, split panes, inspector drawer, full-bleed canvas/terminal.

**Navigation:** global shell = workspace switcher + mode switcher (Workflow/Projects) + command palette (⌘K — navigate, run actions, start goals) + notification/action indicators. Mode switch preserves context per mode.

**Complexity management:** progressive disclosure everywhere — beginner view (steps, plain language) vs advanced view (full DAG, raw payloads, policies) as a per-user toggle; node inspector layers summary → I/O → verification → cost → raw. Real-time status grammar: one canonical set of run/node states with fixed color+icon+motion semantics shared by timeline, canvas, terminal, notifications, CLI. Failure/recovery representation per Part 18.

**Accessibility:** WCAG 2.2 AA target; full keyboard navigation (canvas included — arrow/tab node traversal); screen-reader annotations for live regions (run status updates); reduced-motion support; high-contrast theme; focus management in streaming views.

**Localisation:** EN + HI live; translation keys (`workflow.status.running`), namespaces, plural/date/number/currency rules, RTL-ready layout, user + workspace language preference, fallback EN. Platform chrome language independent from workflow content/voice/customer-message languages.

---

# Part 12 — Real-Time & Streaming Architecture

Transport: SSE (Engine → Streaming Gateway → browser). Envelope: `{seq, event, run_id, ts, data}` with monotonic per-stream sequence + event IDs.

Displayed streams: run progress, model output deltas, agent messages, node transitions, recovery actions, approvals, deployment progress, test output, terminal output, notifications, provider health.

Requirements: resume via `Last-Event-ID`; heartbeats; automatic reconnect with jittered backoff; ordering enforced by seq (out-of-order buffered); replay of missed window from Engine on resume; browser refresh → state endpoint hydrate + stream re-attach (stream is never system of record); auth revalidated on every reconnect and on permission change (revoked → stream closes); backpressure via server-side coalescing of high-frequency deltas; stale-state banner when stream silent past heartbeat window ("last updated Xs ago"); multiplexing — one gateway connection per browser tab fan-out to widgets. WebSocket deferred to genuinely bidirectional features (collaborative canvas presence, interactive sandbox shells).

---

# Part 13 — Platform Security Architecture

- **AuthN:** Auth0 Universal Login (email/password + Google; enterprise SSO SAML/OIDC per tenant); MFA available, enforced for admins; session = secure HttpOnly SameSite cookies, short-lived access + rotating refresh; device/session management UI.
- **Service auth:** platform-api → Engine per API Spec (M2M + 5-min signed `X-Alter-Actor-Token`, jti-checked). Background jobs use service actors.
- **AuthZ:** server-side RBAC in platform-api; client flags never authorize; default-deny.
- **Web security:** strict CSP (nonce-based scripts, no unsafe-inline), CSRF tokens on state-changing browser calls, X-Frame-Options/frame-ancestors deny (except sandboxed preview embeds), input validation via shared Zod contracts, output encoding, dependency scanning in CI.
- **Uploads:** allowlist types, size caps, malware scan before ADS ingestion, served via signed URLs from object storage, never from app origin.
- **Credentials:** references only; values write-only via SecretsProvider; masked display; scoped per workspace; audit on every reference use.
- **Marketplace supply chain:** publishing pipeline (draft → private test → submitted → automated scan → human review → published → suspend/deprecate/remove); package + malware scanning; capability manifests; permission review; version pinning; kill-switch revocation propagating to installed tenants; trust levels (Alter Verified / Verified Publisher / Community Reviewed / Unverified Private / Blocked); install grants nothing automatically — permissions requested, displayed, explicitly approved.
- **Connector permissions:** least-privilege OAuth scopes, displayed pre-consent, revocable, health-monitored.
- **Free-tier abuse:** email/phone verification, rate limits, fraud scoring, hard budgets, no irreversible external actions without approval, marketplace purchase limits.
- **Audit:** every admin action, support grant, credential change, publish decision, permission change → audit-service (tamper-evident chain). Support access customer-visible.
- **Deletion/privacy:** right-to-delete UI (F47) drives the platform-wide deletion flow (manifest → purge → certificate); privacy settings per tenant; DPDP/GDPR-aligned retention per Governance policy.

---

# Part 14 — Provider & Plugin Architecture

Alter-owned interfaces (Platform set; Engine set in Tech Spec):

```
IdentityProvider        RepositoryProvider      DeploymentProvider
ObjectStorageProvider   NotificationProvider    EmailProvider
TelephonyProvider       ObservabilityProvider   ConnectorProvider
KnowledgeProvider(ADS)  VectorStoreProvider     SecretsProvider
BillingProvider         MarketplacePayoutProvider  SearchProvider
FeatureFlagProvider     DurableJobProvider      EntitlementProvider
WebHostingProvider      GPUComputeProvider      NetworkConnectivityProvider
```

Every interface defines: capability declarations, configuration schema, health checks, fallback behavior, versioning, contract tests, migration procedure, rollback procedure, mock adapter. Rules: vendor SDKs only inside adapter packages; canonical Alter request/response schemas; capability registry gates substitution (no silent downgrade); per-tenant overrides where allowed; provider swap = config + credentials + adapter activation + contract tests, never product-logic changes. Capability-based requests (e.g. `language: hi-IN, latency_class: realtime, quality_tier: premium`) — adapters resolve concrete services.

---

# Part 15 — Framework & Technology Decisions

| Decision | Choice | Why | Alternatives | Replacement boundary | Risk |
|---|---|---|---|---|---|
| Frontend | Next.js App Router + React + TS | RSC streaming, Vercel synergy, team standard | Remix, SvelteKit | container-buildable, WebHostingProvider | App Router complexity |
| BFF/domain API | NestJS + Fastify | DI, guards, module boundaries; already Engine-side standard | tRPC-only, Express | OpenAPI contract | boilerplate |
| Components | shadcn/ui + Tailwind + Alter library | ownable code, token-friendly | MUI, Chakra | design tokens | discipline needed |
| Canvas | React Flow (@xyflow) | mature DAG editor, custom nodes | rete.js, custom | canvas component API | perf at 500+ nodes — virtualize |
| Code views | Monaco | VS Code parity, diff view | CodeMirror 6 | editor wrapper | bundle size — lazy load |
| Terminal | xterm.js | standard, addons | hterm | terminal wrapper | none significant |
| Server state | TanStack Query | cache, SSE-invalidations | SWR | query-layer wrapper | none |
| Client state | Zustand (limited) | minimal, no boilerplate | Redux, Jotai | store isolation | misuse for server state — lint rule |
| Forms + validation | React Hook Form + Zod | shared schemas w/ contracts | Formik | contract package | none |
| Streaming | SSE + custom gateway | ALB-friendly, resumable | WebSocket | Streaming Gateway | bidirectional later needs WS |
| i18n | next-intl (or equivalent key-based) | App Router support, namespaces | react-i18next | translation-key contract | HI coverage effort |
| Testing | Vitest, Testing Library, Playwright, axe-core | per Test Plan | Jest, Cypress | — | — |
| a11y tooling | eslint-plugin-jsx-a11y + axe CI | automated floor | manual only | — | automation ≠ full compliance |
| Monorepo/CI | Nx + pnpm + GitHub Actions | shared with Engine | Turborepo | — | — |
| Flags | AWS AppConfig | shared with Engine, kill switches | LaunchDarkly | FeatureFlagProvider | UI less polished |
| Observability | OTel + Grafana Cloud + Sentry + Core Web Vitals | per Deploy Checklist | Datadog | ObservabilityProvider | — |
| Search | Postgres FTS (tsvector + trigram) | no extra cluster at v1 scale | OpenSearch, Algolia, Typesense | SearchProvider | migrate at scale |
| Billing | Razorpay (primary) + Stripe (adapter, on approval) | India-first; Route for splits | — | BillingProvider / MarketplacePayoutProvider | Stripe India onboarding timing |

---

# Part 16 — Platform Infrastructure

| Service | Initial provider | Replacement options | Owner | Portability boundary |
|---|---|---|---|---|
| Web hosting | Vercel | Fargate, Cloudflare, Netlify, K8s, customer infra | platform-web | WebHostingProvider; container-buildable |
| API hosting | ECS Fargate (ap-south-1) | EKS, Cloud Run | platform-api | ComputeProvider |
| CDN | Vercel edge + CloudFront (assets) | Cloudflare | shared-services | asset URLs via adapter |
| WAF | AWS WAF (+ Vercel firewall) | Cloudflare | security | config-level |
| DNS | Route 53 | Cloudflare DNS | shared-services | provider-neutral records |
| Auth | Auth0 | Cognito, Identity Platform | C1 | IdentityProvider (OIDC) |
| Object storage | S3 | GCS, R2, MinIO | platform-api | ObjectStorageProvider, artifact IDs |
| Database | Aurora Serverless v2 (platform_db, marketplace_db) | RDS, AlloyDB, Cloud SQL | per-service | RelationalDatabaseProvider |
| Cache | ElastiCache Redis | Memorystore, Valkey | platform-api | CacheProvider (disposable) |
| Event transport | EventBridge + SQS | Pub/Sub, Kafka | shared | QueueProvider/EventBusProvider |
| Background jobs | Temporal Cloud `platform` ns | self-hosted Temporal, Restate | C24 | DurableJobProvider |
| Email | SES | SendGrid, Postmark | C17 | EmailProvider |
| Notifications | internal + SES | push providers later | C17 | NotificationProvider |
| Observability | Grafana Cloud + Sentry + Langfuse Cloud | self-hosted stack | plane | ObservabilityProvider |
| Feature flags | AppConfig | LaunchDarkly, Flagsmith | plane | FeatureFlagProvider |
| Marketplace storage | S3 + marketplace_db | — | C14 | ObjectStorageProvider |
| Search | Postgres FTS | OpenSearch, Algolia, Typesense | C26 | SearchProvider |
| Preview environments | Vercel previews (web + generated apps); ephemeral CI stacks (api) | — | CI | per Env & Config spec |
| Payments | Razorpay (+ Route); Stripe (+ Connect) when approved | — | C18/C15 | BillingProvider, MarketplacePayoutProvider |
| Telephony | Exotel, Twilio | per matrices | C21 | telephony provider interfaces |
| Tool/MCP runtime | E2B / Fargate in `alter-sandbox-exec` | future sandbox providers | C16 | SandboxProvider |

---

# Part 17 — Platform Observability

Frontend: OTel browser traces (route transitions, API spans) linked to backend trace IDs; Sentry errors with source maps + release tracking; Core Web Vitals (LCP/INP/CLS) per route; user-session diagnostics (session replay optional, privacy-gated). Backend: request traces platform-api → Engine/ADS/providers with `traceparent` propagation; RED metrics per endpoint; SSE stream health (connections, resume rates, lag). Domain: execution timeline views fed by Engine traces; provider health dashboard (per-adapter checks + fallback events); connector health (sync success, OAuth expiry); deployment health (F17); marketplace events (installs, review pipeline, scan failures); cost/usage surfaces (C18). Alerts: routed per Deploy Checklist severity ladder (Slack / PagerDuty / phone). Audit trails: Part 13 events queryable in Audit Explorer (admin) and customer audit view. Every feature must emit: usage event, error path, trace span, and (where costed) cost attribution — enforced at PR review.

---

# Part 18 — Failure, Degraded & Recovery UX

Canonical principle: the user always knows **what happened · what Alter is doing · whether action is required · what is safe · what completed · what did not complete**.

| Condition | UX representation |
|---|---|
| Model failure (node) | node marked failed → recovery badge "retrying with stronger model"; timeline entry; no raw provider errors |
| Provider outage | global degraded banner + provider health chip; affected actions disabled with reason; fallback noted ("running on backup provider") |
| Delayed workflow | run shows "waiting" with cause (backoff, queue, human) + expected next attempt |
| Failed deployment | deployment card: failed stage, log link, one-click retry/rollback; previous version marked still-live |
| Failed integration | connection health red + affected workflows listed + reconnect CTA |
| Expired credential | proactive notification before expiry; affected triggers paused with explicit state, never silent failure |
| ADS ingestion failure | source shows failed docs count + per-doc reason + reprocess action |
| Partial result (graceful degrade) | result flagged "partial — X of Y completed"; missing parts enumerated; nothing implied complete |
| Recovery in progress | live recovery strip: strategy, attempt count, next step |
| Human intervention required | Human Action Centre item + notification + run paused state with resume expectations |
| Complete failure | honest terminal state: what completed, what didn't, what was rolled back, recommended next action |
| Rollback | version timeline shows rollback event, actor, reason; current active version prominent |
| Restored service | banner clears with "recovered at T"; backlog processing indicator until caught up |

Rules: every error state maps to an `error_code` + documentation key; no stack traces or vendor internals to customers; degraded ≠ hidden — stale data always timestamped; irreversible actions never auto-retry without policy permitting.

---

# Part 19 — Marketplace & Ecosystem Architecture

**Asset types:** workflow templates, project templates, agents, tools/connectors/MCP servers. **Publishing pipeline:** `draft → private testing → submitted → automated review (schema, scan, capability audit) → human review → published → suspended/deprecated/removed`. No anonymous public publishing; public publishing = verified tenants; paid = KYC + tax + bank + marketplace agreement + security/content review.

**Commerce:** free + paid listings live v1. Revenue share 80% seller / 20% Alter (covers processing, hosting, scanning, review, distribution, support, dispute risk); taxes + provider fees computed before settlement. Payments: Razorpay primary (Route for splits/settlements, Subscriptions for plans); Stripe adapter (Billing + Connect) activates on India approval. Licensing: per-listing license type (single-workspace, tenant-wide, resale-prohibited), machine-readable, enforced at install.

**Trust & safety:** trust levels (Alter Verified / Verified Publisher / Community Reviewed / Unverified Private / Blocked); capability manifests + explicit permission approval at install; malware/package scanning in sandbox-exec; version pinning + compatibility validation (DAG schema, node-type versions) before install; revocation kill-switch propagates to installed tenants with operator notification; moderation queue + takedown + appeal in Admin Console; ratings/reviews (verified-install only, moderated).

**Compatibility:** every listing declares: DAG schema version, required node types + versions, required connector capabilities, required entitlements. Install blocked with explanation if incompatible.

**Future (architected, v1.x):** private enterprise marketplaces (tenant-internal catalogs), revenue-share tiers, subscription assets, cross-region catalogs.

---

# Part 20 — Gap Analysis (additions already folded into index) & Architecture Risks

**Gaps closed as new features:** onboarding/first-run (F41 — self-service survival), self-serve billing UI (F42 — public signup requires it), abuse/fraud controls (F43 — free tier + paid marketplace demand it), support-access consent view (F44 — enterprise trust), localization (F45), global search (F46), data export + right-to-delete UI (F47), admin consoles as explicit features (F48), seller console/payouts (F10), marketplace governance (F11), simulation/activation (F39), project build experience (F40).

**Risks (ranked):**

1. **Scope vs Aug 2 (11 days).** Full marketplace + payments + KYC + self-service + two modes + 68 surfaces. *Mitigation: max parallelism, managed services, feature flags allowing dark-launch; risk formally accepted by product owner.*
2. **Payment/KYC compliance latency** — Razorpay Route onboarding, KYC review flows involve third-party timelines outside Alter control. *Early account setup; Stripe path parallel.*
3. **Marketplace abuse at launch** — paid assets + free tier attract fraud day one. *F43 controls, verified-publisher gate, curated initial catalog.*
4. **Canvas complexity** — React Flow at large DAGs + round-trip editing correctness. *Virtualization, golden round-trip tests (edit→compile→edit).*
5. **SSE scale** — many concurrent streams through gateway. *Coalescing, per-tab multiplexing, load tests per Test Plan.*
6. **i18n debt** — HI translations lagging features. *Translation keys mandatory in PR gate; missing-key CI check.*
7. **Vercel/platform-api split-brain auth** — session on Vercel edge vs API on AWS. *Single Auth0 issuer, short-lived tokens, CORS allowlist, no session logic duplication.*

---

# Final Summaries

1. **Platform definition:** the complete user-facing product, control plane, and ecosystem layer over the headless Alter Engine and ADS — two modes, public self-service + managed enterprise, paid marketplace, category-defining ambition.
2. **Feature count:** **48 final features** (F1–F48): 23 retained, 8 merged results, 2 split results, 1 renamed, 14 new; 4 originals re-homed as architecture/cross-cutting, "Brain Engine" name removed.
3. **Logical components:** **27** (C1–C27) + Design System + 5 shared planes.
4. **Deployable grouping:** `platform-web` (Vercel) · `platform-api` (Fargate — C1–C23, C25–C27) · `platform-workers` (Fargate, Temporal `platform` ns — C24) · `alter-cli` (distributed binary) · marketplace scanning jobs (sandbox-exec). Components may split into further deployables without domain-model change.
5. **Surface inventory:** **68 surfaces** (16 shared, 15 Workflow, 18 Project, 7 marketplace, 12 admin/operator).
6. **Connection count:** **23 Platform connections** (P1–P23) + Engine-internal wires documented separately.
7. **Cross-cutting planes:** Security & Governance, Observability, Provider Adapter Layer, Contract Plane, Feature Flags/Config.
8. **Infrastructure inventory:** 20 services (Part 16), all with initial provider + replacement options.
9. **Provider-adapter inventory:** 24 Alter-owned interfaces (Part 14).
10. **Technology stack:** Next.js/React/TS on Vercel · NestJS+Fastify on Fargate · Temporal Cloud (`platform` ns) · React Flow · Monaco · xterm.js · TanStack Query · Zustand · RHF+Zod · shadcn/Tailwind · next-intl · Postgres FTS · AppConfig · Razorpay/Stripe · OTel/Grafana/Sentry · Nx/pnpm/GitHub Actions.
11. **Unresolved decisions:** production domain (unconfirmed — no invented names); exact free-tier credit value (configurable at launch); Stripe India activation timing; session-replay privacy decision; HI translation coverage scope at launch.
12. **Conflicts found in original list:** marketplace/self-service vs prior PRD exclusions (resolved: PRD overridden); "Brain Engine" vs approved ADS/ADS Q architecture (resolved: name removed); Inngest vs Temporal substrate (resolved: Temporal, no second orchestrator); Neon/Drizzle/pgvector hardcoding vs provider-neutral ADS (resolved: adapter contract); Next.js-as-whole-architecture vs BFF reality (resolved: NestJS is the BFF); LinkedIn/X as standalone features vs connector catalog (resolved: folded in).
13. **Additions/removals/merges/renames:** additions F10, F11, F39–F48; removals: none capability-level — only name ("Brain Engine") and re-homed items; merges: A2+A4→F2, B10+B11+B12+F45→F12–F14, C16+C17→F18, C20+C18+C19→F19, C22+E26→F21; splits: A3→F3+F4; rename: F38→Unified Command Experience.

**Nothing orphaned:** every feature maps to an owning component (Part 3), a surface or background process (Part 4/5), a data source (Part 7), connections (Part 6), a security boundary (Part 13), and an observability path (Part 17).

*PRD amendment note: PRD v1.0 §5.2 out-of-scope items (public marketplace, community ecosystem, plugin monetization, public self-service) are superseded by this document per the 2026-07-22 scope decision.*
