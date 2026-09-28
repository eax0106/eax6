# Design-log conformance pass (Track D)

Run 2026-09-28, after Phase 4, Track B and Track C, as decided on 2026-09-16
(`docs/memoryalter.md`, "a full design-log conformance pass, after the builds"). The whole of
`docs/architecture/design-log.md` (§1–§33) is read against `main` at this date, together with the
binding rules of `planes.md` adopted in decision 0.7. Evidence is a file path in this repository
or a measured number; nothing below is carried over from an earlier assessment without being
checked again today.

**Rules of this pass (D2, D3).** Every divergence is recorded here before anything is changed.
A divergence ends in one of three ways, and the pass may choose any of them:

- **code** — the log is right and the code must change;
- **amend log** — the code, or a later recorded decision, is right and the log is stale;
- **decision** — Havish has to choose; nothing is built on a guess.

Where the code must change but the component is one of the 25 frozen Category 1 components, the
row says **freeze** — it cannot be built without a recorded exemption, which is itself a decision.

## Summary

| Verdict | Sections |
|---|---|
| Conforms | §3, §6, §13, §14, §20, §24, §27, §28, §33 |
| Conforms, with divergences recorded below | §1, §2, §5, §7, §8, §11, §15, §18, §19, §21, §22, §30, §31 |
| Diverges | §4, §9, §10, §12, §16, §17, §23, §25, §26, §32 |
| Status notes only | §29 |

38 divergences are recorded. **1 is fixed in this pass** (D-31a, a code fix outside the freeze, PR #46);
**4 are log amendments proposed** for Havish to accept (D-4a, D-7a, D-32a, D-23a); the rest are
already on the board as Track C items or go to the decision list.

---

## §1 What Alter is — conforms

Workflow Mode is the product; the Architecture Synthesizer and Planner were rewritten in Phase 4
on the model gateway (`apps/intelligence-service/src/architecture_synthesizer/`,
`src/planner/`), closed 2026-09-28 at 35/36 on the 4.1 golden set. The two R&D risks the log names
are still the two open risks: topology correctness is measured by that golden set, and live agent
creation mid-failure is reachable only through `swap_agent`, which dispatches only when a
capability resolver is configured (`recovery-dispatch.service.ts:339`).

## §2 Agent library & tenant isolation — conforms, one gap

- Tenant isolation is Postgres RLS keyed on `app.current_tenant_id` in every tenant database;
  the platform-api runtime role is `platform_app` (NOBYPASSRLS) since 6.1c.
- The internal-only global view is the staff admin console behind the staff Auth0 tenant (B1.0).
- **D-2a** — the anonymized cross-tenant pattern layer has nowhere to live: the Policy Store has no
  global tier. → code, **freeze** (Policy Store, Category 1). Board item C11.

## §3 Intelligence / learning — conforms

No custom network or model. Reasoning goes through the Model Gateway's aliases; learning is the
versioned Policy Store (`apps/memory-service/src/policy_store/`), whose promoted rules change
Recovery's choice on the next call without a redeploy (`recovery-strategy-table.ts`,
`selectRecoveryStrategy`).

## §4 Self-heal / recovery — diverges

The spine matches: classify (`failure-classifier.ts`), select strategy
(`recovery-strategy-table.ts`), dispatch (`recovery-dispatch.service.ts`), in that order.

- **D-4a — taxonomy.** The code classifies into ten failure classes
  (`packages/contracts/src/recovery-classification.ts:12`: infrastructure_failure,
  logic_output_failure, timeout, tool_permission_denial, sandbox_crash, rate_limit,
  safety_violation, credential_missing, agent_creation_failure, unknown), not the log's five
  buckets. The ten are finer and map onto the five (transient = timeout/infrastructure/rate_limit/
  sandbox_crash; node's own fault = logic_output_failure/agent_creation_failure; credential gap =
  credential_missing/tool_permission_denial). The log itself marks the bucket list provisional
  (§29). → **amend log**: record the ten classes and their mapping to the five buckets.
- **D-4b — two buckets have no class.** "Target resource/state mismatch" (bucket 4) and "genuinely
  ambiguous outcome" (bucket 5) are not distinguished; both fall into `unknown` or
  `logic_output_failure`. Bucket 5 must route only to the Clarification Loop and never to retry;
  `logic_output_failure` routes to `escalate_model` then `replan`. → code (Recovery is
  Category 3, buildable) **after** D-4a is accepted, because the classes to add depend on the
  amended list. Goes to the decision list with D-4a.
- **D-4c — transient retries escalate to swap.** Bucket 1 says one plain retry, no swap; the table
  sends a second timeout or infrastructure failure to `swap_agent`
  (`recovery-strategy-table.ts`, `decide`). A second transient failure is still transient. →
  decision (part of D-4a): accept "retry once, then swap" as the refined rule, or change it to
  "retry once, then ask".
- **D-4d — safety inside Recovery.** `safety_violation` is classified by Recovery and routed to
  `ask_user` (`recovery-strategy-table.ts`, `decide`). §4 says a safety violation halts the whole
  workflow before Recovery is invoked. → code; the halt belongs in Verification & Quality Gate,
  **freeze** (Category 1). New board item C40.
- **D-4e — no idempotency gate.** Nothing checks whether an earlier attempt already caused an
  external side effect before `retry`/`backoff` re-runs a node; there is no Side-Effect Ledger
  (no table or module found; `git grep -i side.?effect` hits only capability metadata). → code,
  **freeze** (Executor). Board item C8.
- **D-4f — no after-the-fact notice.** Self-heal is never reported to the user: nothing in the
  system calls the notification `createEvent`. → code, B3.1b (notification producers).
- Credential gap → `repair`, which raises an escalation naming the connection and leaves the run
  parked (`recovery-strategy-table.ts`, comment on `DISPATCHABLE_STRATEGIES`): conforms to bucket 3.
- Connector batch-ask after synthesis (§4, last paragraph): the Capability Resolver's pre-compile
  live-connection check is not evidenced. → recorded as **D-4g**, code, Capability Resolver
  (Category 3). New board item C41.

## §5 Verification — conforms in part

- **§5.1 — D-5a.** Success criteria exist and travel from `ProblemSpec` to every compiled node
  (C29), and the Planner fails loudly on an intake criterion assigned to no node
  (`planner/kernel.py`, `retain_and_validate_criteria`). But the criteria are **inferred by the
  model** from the description (`problem_understanding/llm_client.py:41`), and no screen or API
  shows them to the user or lets the user state or confirm them (`git grep success.?criteria` in
  `platform-web`, `platform-api` and the conversation module: no hits). §5.1 requires an explicit
  statement *from the user*. → decision: add a confirm-criteria step in the builder chat, or amend
  §5.1 to "inferred, shown and editable".
- **§5.2 semantic check** — conforms: each node is judged against its own assigned criteria and
  fails on any unmet one whatever the rubric score (C29 slice 2b, PR #38).
- **§5.2 mechanical read-back — D-5b.** Absent. → code, **freeze** (Verification). C36.
- **§5.3 end-of-run holistic check — D-5c.** Absent (`git grep holistic|end_of_run|finalReview`:
  no hits). The global criteria list is retained for it (memoryalter 2026-09-16). → code,
  **freeze** (Verification, Synthesis). C37.
- **§5.4 reviewer isolation — D-5d.** Not established. → code, **freeze**. C9.
- **§5.5 fail-closed** — conforms for the node gate: an error or a missing judgement fails the node
  (`_require_one_judgement_each`, verification-service).

## §6 Build philosophy — conforms

Superseded in part by the 2026-09-08 status (the log is now a standards document; the rebuild
stopped). One folder per component exists (`docs/components/`, 61 folders), each with its
contract's blast radius, fail mode and driver since C13.

## §7 Architecture baseline — conforms in intent, mechanism differs

The four patterns are enforced by the AST gates imported in C1 (`scripts/gates/`), run in CI
against `baseline.json`, which only ratchets down. Measured today, 547 recorded findings:

| Gate | Pattern | Findings |
|---|---|---|
| mock-reachability | 1 | 25 |
| unsafe-default | 2 | 219 |
| driver-existence, verifier-driver | 3 | 59 + 2 |
| duplicate-primitive | 4 | 146 |
| safety-duplicate | 4 (§11) | 34 |
| cost-no-float | §9 / planes 39 | 61 |
| capability-coverage | §19 | 1 |

- **D-7a — pattern 1 mechanism.** The log prescribes a `NOT_PRODUCTION_READY`/`Stub<T>` marker;
  no code uses one (`git grep`: 0 hits). The mock-reachability gate plus `RUNTIME_MODE` (C2, where
  a mock in production is a boot error, proven by `check-production-boot.sh` in CI) close the same
  hole without a marker. → **amend log**.
- **D-7b — the baseline itself.** 547 recorded violations are 547 divergences from §7, accepted
  as the starting line so none can grow. → code, over time; no single board item. Recorded so the
  number is not mistaken for zero.

## §8 Editing & override — partly conforms

- The canvas reads the compiled DAG and saves by `PATCH /api/v1/workflows/:id` with the DAG itself
  (`platform-web/src/api/live.ts`, `saveWorkflowGraph`), not a separate visual copy: conforms.
- **D-8a** — no pre-flight advisory on a manual internal override (materiality pushback) and no
  "did the goal change?" prompt when an edit touches stored criteria (`git grep
  materiality|override_advisory|impact_analysis`: no hits). → code, depends on real Selection &
  Binding scoring. New board item C42.

## §9 Cost & budget — diverges

- **D-9a — per-run hard cap (user-set).** Absent. The Model Gateway enforces a per-call limit per
  tenant (`model-gateway.service.ts:281`), which is a different control. → code, Run Manager,
  **freeze**; with C10.
- **D-9b — always-on pre-run estimate.** Absent: live mode shows "-" for workflow estimates
  (B2.9a) because nothing computes one. → code. New board item C43.
- **D-9c — period budget scope.** Budgets are per **workspace**, monthly (migration 0024, B2.9b);
  the log says per **workflow**, daily or monthly. → decision: add per-workflow and daily, or
  amend §9 to workspace-level.
- **D-9d — hard stop.** Thresholds are stored, not enforced. → code, **freeze** (Run Manager). C10.
- **D-9e — threshold alerts.** Not sent. → code, B3.1b; needs the system principal for cost reads
  (decision list).

## §10 Workflow organization — diverges

- **D-10a** — no "Ungrouped" bucket and no project-folder grouping of workflow sessions in code
  (`git grep -i ungrouped`: hits only in ads-core's Google Drive connector). Projects exist in the
  engine as a separate object, not as folders of workflows. → decision: are projects the folders,
  or build folders?
- **D-10b** — ADS retrieval is scoped by tenant and workspace (`ads-core/src/query`), which covers
  "all of one user's workflows" only if a user keeps them in one workspace. → recorded; resolves
  with D-10a.

## §11 Safety & Policy as a shared library — diverges

Screens live in Conversation Manager and Model Gateway, and ads-core is called over the network;
the safety-duplicate gate records 34 findings. → code, **freeze**. C4.

## §12 Cache deferred — diverges

**D-12a** — a semantic cache is live in front of every model call at a 0.95 cosine threshold
(`packages/adapters/src/redis/redis-cache-provider.ts:46`). C17 decided exact-match only
(2026-09-15) and its implementation is still to do. → code, **freeze** (Model Gateway). New
board item C44.

## §13 Executor — conforms

Own module: `packages/adapters/src/temporal/workflows/executor-workflow.ts` and activities,
dispatching to handlers through the registry.

## §14 Node Type Registry — conforms

`apps/orchestration-service/src/registry/` (handlers per node kind, `/api/v1/node-types`).

## §15 Multi-user accounts — conforms in part

- Tenant roles owner > admin > billing > member and workspace roles admin, editor, operator,
  approver, viewer (`apps/platform-api/src/rbac/permissions.ts`); invites
  (`members.controller.ts`). Resources belong to the tenant.
- **D-15a — permission model.** Permissions are 27 route-derived strings, not "about 10
  toggles", and there are **no custom roles** (`git grep -i custom.?role`: no hits). → decision:
  build custom roles over a closed toggle set, or amend §15 to fixed roles.
- **D-15b** — the tenth toggle, "change data retention settings", does not exist because the
  setting does not exist (D-18c).

## §16 HumanApproval modes — diverges

**D-16a** — one mode (always block). → decision, C30 (plus open question 8, delivery channel).

## §17 Proactive improvement — diverges

**D-17a** — the Drift Detector has no outbound suggestion path. → code, after B3.1b. C39.

## §18 Retention & deletion — conforms in structure, diverges in coverage

- Schema-derived and CI-enforced: every one of 125 tables in 8 databases is registered, CI builds
  them from real migrations and fails on an unregistered or stale table (C3, PR #40). Conforms to
  the structural requirement and to §28.
- **D-18a — coverage.** Erasure reaches 38 of 100 tenant tables; 62 are gaps. → code, C3b, after
  the retention decision.
- **D-18b — audit minimization and pseudonymisation.** Neither exists in audit-service (`git grep
  -i "pseudonym|minimi[sz]e"` in `apps/audit-service/src`: no hits). → code, part of C3b; the
  retention decision says which applies.
- **D-18c — user-configurable run-history retention** (7 days to 1 year, destructive-lowering
  confirmation). Absent. → code. New board item C45.

## §19 Onboarding — diverges in part

Onboarding exists in platform-api (`src/onboarding`) and platform-web. **D-19a** — the Capability
Registry holds no workflow templates (capability-coverage gate reports the registry's absence).
→ code, **freeze**. C38.

## §20 Authentication — conforms

Managed provider (Auth0) with RS256 token validation (`packages/auth/session-gateway/src/m2m-validator.ts`, mirrored by each Python service's `service_auth.py`); social and email sign-in are Auth0
connections (configured in the tenant, 6.1b); member invites exist. Enterprise SSO deferred.

## §21 Monetization — conforms in shape, one gap

Plans and prices are data (`ALTER_CONFIG_SOURCE: local-file` plan definitions), not code.
**D-21a** — the Cost Ledger does not record verification verdicts. → code, **freeze**. C5.

## §22 Component list — conforms in part

- Agent Factory is its own component (C7, PR #44). Approval record is engine-owned with the inbox
  as a platform read model (decision 0.5). Billing is separate from Cost Ledger.
- **D-22a** — Side-Effect Ledger absent (= D-4e, C8).
- **D-22b** — atomic budget gate absent (= D-9d, C10).
- **D-22c** — Policy Store global tier absent (= D-2a, C11).

## §23 Project Mode out of v1 — diverges

**D-23a** — Project Mode code is present and reachable: the Planner's plan-then-execute strategy
builds a fixed 14-stage project skeleton (`planner/kernel.py`, `build_project_skeleton`), and
orchestration provisions project runs (`runs/project-run-provisioning.service.ts`). It arrived
with the alter-x-4- imports. → decision: gate it off in v1 (the log), or amend §23 to "present,
not offered". Recommendation: amend to "present, not offered in the v1 UI", since removing it
would touch Planner, Provisioning and the run launcher and §23 itself forbids designing it out.

## §24 Two-path engine — conforms

Recovery's `replan`/`recompile` sends the version's `TaskSkeleton`, not the compiled DAG
(`recovery-dispatch.service.ts:55-63`; Planner `replan` parses a `TaskSkeleton`). Decision 0.2 is
implemented.

## §25 Public Surface — diverges

**D-25a** — there is no hosted public form. The only public inbound surface is webhooks
(`orchestration-service/src/webhooks/whatsapp-webhook.controller.ts`). → decision: v1 needs the
lead-capture form of §1's own example, or amend §25 to "webhooks only in v1".

## §26 Naming — diverges

**D-26a** — "Session Gateway" survives in 61 files (`SessionGatewayGuard`, `SessionGatewayRequest`
in `packages/auth`, orchestration's `sessionGatewayEnvironment`). §26 says the rename is binding
across code. → decision: the rename touches `packages/auth` (shared by every service) and
frozen components; do it as one mechanical rename, or amend §26 to "binding in documents; code
renamed when touched".

## §27 Platform Web surfaces — conforms

Chat & builder, canvas, run monitor, approval inbox and account/admin all exist in
`apps/platform-web/src/features/`, and live-mode wiring follows the backend (Track B).

## §28 Deletion registration — conforms

See §18: `packages/deletion-registry` and the CI certification step (C3).

## §29 Open items — status

- Classify buckets: proposal D-4a.
- Blast radius / fail mode: now carried by every component README (C13); 17 components have no
  contract and keep proposed values.
- Credit pricing: still Havish's.
- Approval notification delivery: still open (C30, question 8).

## §30 Service-to-service authentication — conforms in part

- Requirement 1 (authenticate the asserter): the memory service calls
  `/internal/runs/:id/outcome-summary` with its own M2M token and the tenant as a parameter
  (`memory_learning/orchestration_client.py:54-62`); orchestration honours the parameter only for
  a service actor (`run-learning.controller.ts:47-50`). Conforms.
- **D-30a** — requirement 2: a tenant that does not own the run is answered as run-not-found
  (`RunOutcomeRunNotFoundError`), not as an explicit refusal with a named reason. → code.
- **D-30b** — requirement 3: service-asserted tenants are not audited (no audit write on that
  path). → code.
Both are in the run-learning controller (Run Manager's run read path). → **freeze** check needed;
new board item C46.

## §31 Agent creation policy — diverges, fixed here

- Refuses above the ceiling with a named reason, and creation converges instead of repeating
  (alter-x-4- #157, imported): conforms.
- **D-31a** — the ceiling defaults to `ADVANCED` (`intelligence-service/src/config.py:33`).
  §31 says it defaults to the standard tier, and memoryalter (2026-09-14) records it as "changed
  to `STANDARD`" — that change never reached `main` (introduced in #157, carried through #9 and
  every import since). → **code, fixed in this pass** (PR #46, board item C47): default `STANDARD`, with a test that
  fails on the old default. Selection & Binding / Agent Auto-Creation is Category 3, not frozen.

## §32 Stored derived data — diverges from the log, closed by a later decision

**D-32a** — the log says the residual is "deferred, not answered". It was answered on 2026-09-14:
the write-only `node_requirements` and `policy_bindings` columns were removed (memoryalter,
"§32's residual is closed by deletion"). → **amend log**.

## §33 Voice and Repository Manager — conforms

Voice declarations removed (`packages/contracts/proto/buf.yaml:10`). Repository Manager returned
under the 2026-09-28 amendment (read-only GitHub via the OAuth Hub, `apps/platform-api/src/repositories`).

---

## New board items created by this pass

| Item | Divergence | Blocked by |
|---|---|---|
| C40 | D-4d safety halts the whole workflow before Recovery | freeze (Verification) |
| C41 | D-4g pre-compile live-connection check, batch connector ask | — (Category 3) |
| C42 | D-8a override advisory and goal-change prompt | real Selection & Binding scoring |
| C43 | D-9b pre-run cost estimate | — |
| C44 | D-12a semantic cache to exact-match (C17's implementation) | freeze (Model Gateway) |
| C45 | D-18c user-configurable run-history retention | retention decision |
| C46 | D-30a/b explicit refusal and audit for service-asserted tenants | freeze check (Run Manager read path) |

## Log amendments proposed (D3) — Havish accepts or rejects

1. **§4 (D-4a, D-4c)** — replace the five provisional buckets with the ten classes and their
   mapping; state the retry-then-swap rule.
2. **§7 (D-7a)** — pattern 1 is enforced by the mock-reachability gate and `RUNTIME_MODE`, not a
   marker type.
3. **§23 (D-23a)** — Project Mode code is present but not offered in v1.
4. **§32 (D-32a)** — the residual is closed: the columns were removed on 2026-09-14.

Decisions that could go either way (build, or amend the log): D-5a, D-9c, D-10a, D-15a, D-25a,
D-26a. They are on the decision list in `docs/work-queue.md`.
