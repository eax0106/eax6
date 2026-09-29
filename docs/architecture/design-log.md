# Alter Engine — Ground-Up Rebuild: Design Log

Running record of decisions made in the architecture/product design conversation for the fresh, ground-up rebuild of Alter Engine (new repo, not a continuation of alter-x-4-/ALTER-X-3). Append to this file as new decisions lock in. Old repos (alter-x-4-, ALTER-X-3) are reference/prior-art only — their code is not the starting point, their audited architecture target and failure patterns are.

Started: 2026-08-30/31.

---

## 1. What Alter Engine is (locked)

Open SaaS product, usable by anyone (not just businesses) — positioned like ChatGPT/Claude on the web, not an enterprise-only managed-client tool (this is a deliberate departure from the old PRD's "managed clients only, no self-service" v1 scope).

Conceptually: a combination of n8n (visual workflow canvas, trigger/action nodes, connector breadth) + LangChain (integrations) + LangGraph (durable, stateful, multi-agent execution graph) — but the graph topology and the agents inside it are designed autonomously by Alter from a description of the problem, not hand-built node-by-node by the user the way n8n/LangGraph require today.

Three use-case classes Alter must cover:
1. **Workflow Automation** — business process automation, data pipelines/integration, standard AI routing (chat, basic RAG, automated tasks).
2. **AI Application Development Framework** — multi-step reasoning loops, custom memory, advanced RAG (chunking, embeddings, vector DB), fine-grained model/prompt control.
3. **Multi-Agent & Stateful Orchestration** — agents that talk to each other, loop until a goal is met (e.g. a code-writing agent + a testing agent looping until tests pass), with real state management across the loop.

Confirmed via fresh research (Aug 2026): graph execution itself is a commoditizing problem — LangChain's own `AgentExecutor` is deprecated as of Oct 2025 in favor of running on LangGraph's engine directly. Nobody in this space (n8n, LangChain, LangGraph) has a layer that decides *what topology should exist* for an arbitrary problem — every one of them requires a human to draw the graph. That gap is Alter's actual differentiator, and it remains genuinely unsolved even by the old Alter build (its own hardening audit found the reasoning underneath this is still shallow — keyword-matched tier inference, 2-of-9 real scoring factors in Selection & Binding).

Honest build-feasibility read: every individual capability (durable multi-agent execution, visual canvas, auto-generated graphs, agent swap-on-failure) has real working precedent, including in the old Alter repo. The two genuinely unproven pieces, nowhere in the industry including the old build: (a) reliably turning an arbitrary problem into a *correct* multi-agent topology, and (b) creating a brand-new agent live, mid-failure, and trusting it immediately. These are real R&D risk, not just engineering effort.

## 2. Agent library & tenant isolation (locked)

- Strict per-tenant isolation: a tenant sees only agents they created. No cross-tenant visibility of agents or agent libraries, at the product level.
- A global view across all tenants exists for internal/dev use only (building, analytics, debugging) — never exposed to tenants.
- This matches the one thing the old build's own audit praised as genuinely correct (RLS with FORCE, real tenant isolation discipline, 16/16 tables) — continuing that discipline by default, not weakening it for convenience.
- **Accepted (locked):** an abstracted, anonymized pattern-learning layer is allowed to inform a shared policy layer across tenants — e.g. "this topology/model-tier tends to work for this task type," containing zero tenant-specific content (no prompts, no data, no agent code, no identifying detail of any kind). Actual agents, prompts, and tenant data stay exactly as siloed as the rest of this section — this only lets Alter's own judgment get better across all tenants over time, never lets one tenant's work reach another.

## 3. Intelligence / learning layer (locked)

- **No custom neural network** for internal decisions (model routing, agent-fit scoring). Wrong tool for a low-dimensional decision problem, no training data exists yet (engine never run), and it breaks auditability — a black-box net can't be rolled back or explained the way a versioned policy entry can.
- **No custom/in-house foundation model.** Cost/compute/data/talent required is orders of magnitude beyond what a foundation-model training run would justify versus just calling existing frontier models (Claude/GPT/etc.) via a swappable Model Gateway. Owning a weaker in-house model would make every reasoning layer (Planner, Architecture Synthesizer, Verification, Recovery) worse, not better, and contradicts the already-locked principle that Alter is never married to one model.
- Reasoning/understanding comes from existing pretrained frontier models, called through a swappable gateway (never locked to one provider/model).
- Alter's own learning loop is a **versioned, symbolic policy store** (routing weights, quality thresholds, recovery preferences, pattern scores) updated by verified outcomes — explainable, inspectable, reversible. Closer to reinforcement-learning-style policy updates than deep learning.
- Future upgrade path, not now: once real usage volume exists, consider *fine-tuning* an existing open-weight model (not training a new foundation model) for one narrow job (e.g. tier classification), added as one more swappable entry in Model Gateway.

## 4. Self-heal / recovery behavior (locked, classification detail flagged for refinement during testing)

- Self-heal (swap to existing agent, or create a brand-new agent) runs **fully autonomously at execution time** — no blocking mid-run approval gate. Engine's mandate: keep the workflow alive at any cost. **Exception: safety violations (see buckets below) — "keep it alive" is the wrong instinct there.**
- User is **notified after the fact**: what failed, what was created/swapped in, what replaced what.
- User can review post-hoc and request changes — engine regenerates/adjusts the replacement agent per that feedback, asynchronously. This is human-in-the-loop, just retrospective rather than blocking.
- **Failure classification is mandatory before self-heal fires**, and lives as the *first internal stage* of the Recovery Policy Engine — not a new component or layer.
- Recovery Policy Engine's internal stages, in order: **Classify → Select Strategy → Dispatch.**
- **Idempotency gate, cross-cutting, sits in front of Dispatch for every bucket below that leads to re-execution:** before any retry or self-heal re-runs a node, confirm the earlier attempt didn't already cause a real irreversible side effect (e.g. a message already sent) that repeating would duplicate. Not a classify bucket itself — a shared safety check every bucket's Dispatch must pass through.

**Classify buckets — 5 real buckets Recovery handles, plus 2 things that look like buckets but aren't (found by deliberately re-examining an earlier 7-bucket draft; flagged explicitly as likely to need more refinement once real testing surfaces cases not yet imagined):**

1. **Transient/environmental** (network blip, momentary rate-limit, brief timeout) → one plain retry, no swap, no new agent. Grounded in the old build's own audited bug: its Recovery dispatch had no classification stage at all, so a transient database error was treated as terminal and permanently dropped a real run a plain retry would've fixed.
2. **Node's-own-fault / deterministic** (broken agent logic, wrong tool bound) → instant self-heal (swap-existing-or-create-new), no wasted retry.
3. **Credential/authorization gap** (user's connector token expired/revoked, or the fix needs a provider never connected at all) → hard stop, no self-heal — swapping the agent doesn't fix a broken or missing credential. Notify user with plain explanation + what to do (reconnect, re-grant). **Technical limit, not a policy choice:** even with a standing user-granted "auto-swap connectors" permission, this can only apply between providers the user *already* connected — OAuth requires the human to click "allow" on the provider's own page, no permission setting bypasses that for a brand-new provider.
4. **Target resource/state mismatch** (credential's fine, but the specific channel/sheet/record was deleted, moved, or had permissions changed) → not fixable by retry, swap, or re-auth. Ask user to redirect the target or recreate the resource.
5. **Genuinely ambiguous outcome** (node executed cleanly, mechanical check passed, but the semantic reviewer can't confidently call it a match to intent) → must route *only* to ask-user/Clarification Loop, never to retry or swap — retrying an ambiguous-but-not-broken result just reproduces the same ambiguity.

**Not classify buckets — handled outside Recovery's Classify stage entirely:**
- **Policy/limit block** (spend cap, rate limit, quota) — primarily a *pre-flight gate* checked before a node is even attempted, not a post-failure classification, since nothing actually failed. Thin fallback: a race condition where two parallel nodes both pass the pre-flight check and together exceed the cap still needs a residual post-hoc catch — that residual case is the only part that touches Classify.
- **Safety/security violation** (node output trips prompt-injection/safety classifier) — must halt immediately, whole workflow not just the node, before Recovery is ever invoked. Recovery's job is "find a way to keep going," which is the wrong instinct here — retry or swap re-exposes the same attack path. Lives as a circuit-breaker inside Verification/Safety, not inside Recovery.

**Tool/credential connection timing (resolved, was open):** Alter asks for all needed connectors as a **batch, after Architecture Synthesizer finishes understanding the full workflow** — not one-by-one interruptions mid-conversation, and not a mandatory pre-connect-everything step before describing any workflow. Reason: the full tool list isn't actually known until the design is complete, so asking earlier risks asking for something that turns out unnecessary. Mechanism lives inside Tool Gateway (already has real credential resolution/token minting in the old build) plus a pre-compile check: Capability Resolver confirms a live connection exists for each required capability before the graph is built.

**Amended 2026-09-29 (Havish, decision D13, from D-4a/D-4c).** Classify uses ten failure classes that map onto the five buckets: transient = timeout, infrastructure_failure, rate_limit, sandbox_crash; node's own fault = logic_output_failure, agent_creation_failure; credential gap = credential_missing, tool_permission_denial; safety_violation is outside Recovery (halts the workflow); unknown goes to a person. Buckets 4 (target missing) and 5 (ambiguous outcome) get classes of their own. A transient failure that repeats is retried once, then swapped. See §34 D13.

## 5. Verification mechanism (locked)

Two-layer, per-node, plus one holistic pass — not a single end-of-run check.

1. **Intake requirement:** before any workflow runs, Alter must capture an explicit, *structured* statement of what success looks like from the user (not just the workflow description itself). This structured statement is the reference every later check is judged against — required because Alter now serves arbitrary, self-invented workflows (not a fixed business domain with a known acceptance criteria set, unlike the old PRD's managed-client model). **Amended 2026-09-29 (D8):** the inferred criteria are shown on the plan step beside the steps, editable, and pressing Build confirms them; a criterion no step covers fails loudly.
2. **Per-node check, immediately after that node executes** (not deferred to the end):
   - **Mechanical check** — confirm the real external system actually reflects the claimed action (e.g. read the Slack channel back to confirm the message exists, read the sheet back to confirm the row exists) — never trust "the API call returned success" alone. This is the exact class of bug (mock/fake success) that broke the old build's workflow builder. **Amended 2026-09-29 (D14):** email passes on provider acceptance, and SES delivery events later mark a bounced send as "delivery failed" on the run and notify the owner; a browser click is confirmed by a page snapshot only when the step states the expected page state, otherwise it is recorded as unconfirmed, never as passed silently.
   - **Semantic check** — a reviewer compares the node's actual output against *that node's own assigned sub-task* (derived from the overall plan at compile time) — same reviewer mechanism as the final check, just scoped to one node instead of the whole run.
   - A node only passes if both checks clear. Either fails → Recovery Policy Engine's Classify stage fires immediately for that node, only that node — not a full workflow restart.
3. **End-of-run holistic check:** even after every node passes individually, one final review compares the combined outcome against the original structured success criteria from step 1 — catches cases where each piece was fine alone but the combination didn't deliver what was actually wanted.
4. **Reviewer isolation (anti-injection):** the output being judged is always passed to the reviewer as clearly-marked data, never as an instruction it could act on — directly fixes the old build's audited "confused deputy" flaw, where a node's own output was fed straight into its own quality judgment.
5. **Fail-closed, always:** if verification errors, times out, or can't get a clean signal, the result is counted as unverified/needs-review — never silently counted as success. Realistic framing: not "100% certain," but "never wrongly claims success it didn't check."

## 6. Build philosophy (locked, from earlier in the conversation)

- New repo, ground-up. Old repos are reference only.
- No mock data during build — every component tested against real execution, evaluated by the user personally, before moving to the next.
- One folder per component in the new repo: own README, own context, own definition of what the finished component should look like — decided *before* code starts.
- Thin UI per component first (real endpoint, raw output, no polish) — built incrementally alongside backend so the user can test the product as it's built, not just pass tests in a terminal. Polish only after full build. Explicit guard against the old build's exact failure mode: UI must never get ahead of real backend wiring (that's what produced the fake/mocked workflow canvas last time).
- User is deliberately in control: personally verifies each piece works before proceeding, wants active pushback from the assistant rather than default agreement (see standing memory: `feedback_pushback_not_yesman.md`).

## 7. Architecture baseline (locked)

Reuse alter-x-4-'s final 8-layer + cross-cutting-plane target (L1 Front Door → L8 Verify/Heal/Learn, plus Governance/Cost/Eval/Contracts/Observability/Safety/Cache planes) as the **structural blueprint**, not its code. Fix the 4 systemic patterns identified in that build's hardening audit, by convention, from commit one:
1. Unmarked mock/stub code → mandatory `NOT_PRODUCTION_READY`/`Stub<T>` marker + CI gate that fails on one appearing in a production path.
2. Missing config silently selecting a mock → single `RUNTIME_MODE` switch; in production mode, any mock selection is a fatal boot error, never a silent fallback.
3. Real machinery with nothing driving it (schedulers, verifiers with zero callers) → mandatory "driver exists" test for every scheduled/background component, not just "the mechanism works when called."
4. Duplicated primitives drifting apart (two ID validators, empty stub packages) → single source of truth per shared primitive, enforced.

**Amended 2026-09-29 (D13, from D-7a).** Pattern 1 is enforced by the mock-reachability gate plus the `RUNTIME_MODE` boot check (a mock selected in production refuses to boot), not by a marker type.

## 8. Workflow editing & override model (locked)

Covers what happens after a workflow's initial graph is built — can the user change it, and how.

- **Conversational edits** — user asks Alter to change the workflow in plain language ("add a step that also emails me"); Alter redesigns the affected part through its normal pipeline (Architecture Synthesizer / Capability Resolver / Selection & Binding), same as initial build.
- **Direct canvas edits — structural, fully in the user's hands, no restriction.** Reorder nodes, delete one, rewire which node feeds which, drop in a placeholder node. This is the *shape* of the graph. The canvas must read/write the actual live WorkflowDAG object, never a separate visual copy reconciled on save — that exact gap (canvas shows one thing, save writes another) is what destroyed real user workflows in the old build.
- **Direct canvas edits — internal configuration (which model, which tool, which prompt powers a node) — user CAN override by hand.** Reversed from an earlier draft of this log that restricted internals to Alter-only; superseded here. Alter still picks every internal by default, autonomously, same as always. But the user can open any node and change what's inside it directly.
- **The override gets an informed pushback, not silence and not a rubber stamp.** Before a manual internal override takes effect, Alter states its own original pick and reasoning, and flags the override *only when the difference is materially significant* — real cost jump, real quality/capability mismatch, real latency problem, a tool that can't actually do what the node needs, expanded permission/security exposure, or a downstream contract break. **Not limited to cost — that was one example, not the scope.** The comparison itself isn't new machinery: it's the same Selection & Binding scoring already run to produce the default, just also shown to the user instead of only applied silently.
- **Materiality threshold is required, not optional** — flagging every trivial difference turns this into constant nagging and trains the user to ignore all of it, including the warnings that matter. Only speak up when the override creates an actual meaningful risk.
- **Two separate checkpoints, not one duplicated — both apply regardless of who configured the node:**
  1. **Pre-flight advisory** (this section) — happens before a manual override takes effect, reasoning-based, not a real test, doesn't block the user from proceeding anyway.
  2. **Post-execution verification** (Section 5, unchanged) — happens after the node actually runs, checks the real outcome. Applies exactly as strictly whether Alter or the user configured that node's internals — arguably more important on user-configured nodes since they're unproven by Alter's own scoring.
- **Impact analysis on any manual edit, before it goes live:** rerun the same DAG-validation the auto-generated graph already gets (cycle check, orphaned-node check, data-type compatibility between newly-connected nodes) — the existing Graph Compiler validator, triggered on a user edit instead of an Alter edit, no new validation logic needed. If the edit affects anything the stored intake success criteria (Section 5) depends on, ask the user whether the goal itself changed too — don't silently keep verifying a deliberate user change against stale original criteria.
- **Trigger setup follows the same pattern, not a separate mechanism:** Alter figures out and builds the right trigger conversationally by default (asking follow-up questions if the user doesn't specify one — form, webhook, schedule, incoming email, etc.), same as any other node. The trigger is just a node the user can also hand-wire directly on canvas if they want to be explicit about it — same structural-freedom-with-Alter-default rule as everything else in this section, applied to Event & Trigger Gateway specifically.

## 9. Cost & budget model (locked, v1 scope)

- **Per-run hard cap (optional, user-set):** "never spend more than $X on this run" — enforced by the Classify-adjacent pre-flight policy/limit-block gate (Section 4).
- **Always-on pre-run estimate:** Alter shows projected cost/credits before every run, regardless of whether a cap is set — keeps the user continuously aware, not just at the moment of hitting a wall. Implementation warning, grounded in a real old-build bug: round the total once, at the end, never round the per-unit price before multiplying — the old build's estimator did the latter and produced estimates 2×–100× over real cost.
- **Per-workflow period budget (new, v1):** user sets a daily or monthly cap for one specific workflow — protects against many small runs of a recurring/event-triggered workflow (e.g. a lead-capture form firing dozens of times a day) quietly adding up past what a per-run cap alone would ever catch.
- **Enforcement default: hard stop** when a period cap is hit — workflow stops running until the period resets or the user manually raises the cap. Matches the fail-closed instinct already used elsewhere in this design.
- **Threshold alerts (v1):** notify at meaningful thresholds (e.g. 50%/80% of period budget) before the hard stop fires, so it's never a surprise. Reuses the same estimate machinery already required for the per-run display — not new infrastructure.
- **Amended 2026-09-29 (Havish, decision D4): how the pre-run estimate is made.** Shown as "usually X (average of the workflow's last 5 verified runs), at most Y (worst case)"; before 5 runs exist, only "at most Y". The worst case is bounded from the compiled DAG (each node's configured `max_tokens` times its alias price, plus fixed tool costs), not from invented token counts. Run start reserves Y against the budget; run end trues up to the actual cost. See §34 D4.
- **Amended 2026-09-29 (Havish, decision D3).** Budgets live in the engine and Run Manager checks them atomically at run start. Kinds: optional per-run cap, per-workflow daily or monthly budget, and the per-workspace monthly budget kept as the umbrella; alerts at 50% and 80%. At the cap the default is a hard stop; a budget may be set to "warn only" by its owner. See §34 D3.
- **Explicitly deferred past v1, real ideas, not dismissed:** account-wide budget across all workflows combined; per-category caps (e.g. cap expensive operations like image-gen separately from cheap ones); degrade-to-cheaper-model instead of hard-stop as the cap nears (reuses Selection & Binding scoring, just not built first); rolling time windows instead of fixed calendar periods (closes a real gaming gap — spend up to cap at 11:59pm, again at 12:01am — but adds real complexity for v1).

## 10. Workflow organization & session model (locked)

- **One workflow = one chat session.** The conversation that builds/edits a workflow and the workflow object itself are the same thing — not a separate "workflows list" pointing at chats, one persistent thread per workflow.
- **Sessions group into named project folders**, plus an "Ungrouped" catch-all for anything not assigned to a group — sidebar pattern confirmed by the user against a real reference screenshot: group header, sessions nested under it, search + filter controls at the top.
- **Cross-workflow context, within one user, is expected and required** — Alter should already have context on a user's other workflows when building a new related one, no need to re-explain from scratch. Concrete requirement this creates: ADS Client's retrieval scope must span *all* of that user's workflows/sessions, not just the current one.
- **This does not weaken tenant isolation (Section 2)** — the isolation boundary is the tenant, not the individual workflow. Cross-workflow sharing happens freely inside one user's own space; the wall between different users' data stays exactly as strict as already locked.
- **Amended 2026-09-29 (Havish, decision D9).** Folders are simple engine-owned named records; a workflow's folder is optional and "Ungrouped" means none; deleting a folder never deletes its workflows. Cross-workflow context spans the **workspace's** workflows (the workspace is a permission boundary), not every workspace a user belongs to. See §34 D9.
- **Amended 2026-09-29 (Havish, decision D6).** One workflow = one chat, confirmed: the chat is where that workflow is built and changed, through the builder pipeline. Added: one read-only assistant per user ("Ask Alter") that answers questions and gives updates across the user's workflows from data the user can already read, and whose only action is to start a new workflow and send the user to its chat. It cannot change any existing workflow. See §34 D6.

## 11. Safety & Policy plane (locked): shared library, not a standalone service

- **Neither a real standalone service nor duplicated per-gateway logic (old build's accidental answer) — a shared in-process library.** The actual SSRF-guard, prompt-injection-classifier, and PII-redaction logic lives in one package; Model Gateway, Tool Gateway, and Sandbox each import and run it directly in their own process.
- **Why not a standalone service:** safety checks fire constantly (every tool call, every model call, every node output) — a network hop on every one of those adds real latency to the hottest paths in the engine, and turns that service into a new single point of failure every gateway depends on.
- **Why not per-gateway duplication:** exact bug the old build actually shipped — Tool Gateway's fetcher had no response-size cap while Sandbox's did, same logic reimplemented twice, drifted apart, one wrong. A shared library is one place to fix, one place to test, no drift — directly matches the Section 7 fix for duplicated primitives.
- **Tradeoff accepted knowingly:** gives up independent scaling and hot-updating the logic without redeploying every gateway that uses it. Acceptable for a small team building v1 — revisit only if that specific need becomes real.
- **Amended 2026-09-29 (Havish, decision D15): one implementation per language, proven not to drift.** The SSRF guard, injection classifier and PII redaction each have exactly one TypeScript implementation and, where a Python service needs one, one Python implementation; a CI parity test runs both classifiers over one shared case set and fails on any disagreement. That test, not a single folder, is what enforces "no drift". See §34 D15.

## 12. Cache/Reuse plane (locked): defer past v1

- **Deferred, not rejected.** Needs real usage volume to be worth anything — nothing to reuse on day one, same reason the intelligence/learning layer (Section 3) is versioned-policy-now, fine-tuning-later. Building it now competes for effort against things load-bearing for the engine to work at all (Recovery, Verification, the core execution loop). Engine functions completely without it, just costs a bit more per run early on.
- **Explicitly not a quality tradeoff — worth being precise about why.** Caching reuses a result that already passed the exact same verification pipeline (Section 5: per-node dual check, fail-closed, isolated reviewer) a fresh run would go through. If the work is identical or near-identical, the cached answer *is* the verified answer, not a lesser one — nothing about quality is skipped, only redundant recomputation. This is a different thing entirely from a real cost-vs-quality tradeoff (e.g. picking a weaker model tier to save money), which is Selection & Binding's job, not caching's.
- **Confirms a principle that already holds everywhere else in this design, not a new one:** cost never silently downgrades quality anywhere in this engine. A hard budget cap stops the run outright (fail-closed, Section 9) rather than quietly substituting a worse model. Any cost-driven choice gets surfaced with pushback, never applied silently (Section 8). Caching was never in tension with this principle to begin with, since it never produces a different answer — only skips recomputing an identical one.

## 13. Executor (locked): own bounded module

- **Gets its own module, not folded into Graph Compiler or the Durable Runtime** — reverses the old build's accidental answer, where Executor's logic ended up smeared across `runs`/`compiler`/`blackboard` because no one drew an explicit boundary for it.
- **Job is genuinely distinct from its neighbors:** walks the compiled graph node-by-node (or wave-by-wave for parallel steps) during a real run, dispatches each node to Model Gateway/Tool Gateway/Sandbox, feeds results into Blackboard, hands off to Verification after each node. Different responsibility from Graph Compiler (builds the DAG before any run starts) and Run Manager (queues/dispatches runs to Temporal, doesn't touch node-by-node execution).
- **Why it matters now, not just later:** the already-locked build philosophy (Section 6) — one folder per component, own README, own target-spec — can't actually apply to Executor if there's no defined "Executor" to point a folder at. Leaving it folded reintroduces blurred ownership before line one of code exists.

## 14. Node Type Registry (locked): build as real, separate from Executor

- **Real registry component, not hardcoded into Executor.** Tells Executor *how* to run a given node kind — LLMTask (agent-powered), ToolCall (mechanical action), Gate/conditional branch, HumanApproval (the approval-gate pattern already locked for self-heal and manual overrides), Merge (parallel branches rejoining), Synthesis, plus PubSub/GroupChat/SandboxExec from the old spec. New node kind = new registry entry, Executor itself untouched.
- **Direct continuation of the Executor decision (Section 13), not an independent call.** Executor got its own module specifically because "walk the graph and dispatch" is a different job from "know how every node type works internally." Hardcoding node-type logic into Executor would undo that separation in the same breath it was drawn.
- **Matters more here than a typical registry** because new node types are explicitly part of the product's own future — Alter creating new capabilities over time. A real registry means that growth never requires touching or redeploying Executor.

## 15. Multi-user / team accounts (locked)

Closes gap #1 from the pre-microarchitecture review (Section 16 below lists all seven; this is the first resolved).

- **A tenant can be one person or an organization with multiple human members** — not strictly single-user. Resolves the earlier tension between the personal-tool framing ("like ChatGPT/Claude on the web") and business use cases that naturally involve more than one person touching a workflow.
- **Resources belong to the tenant, not the individual member who created them** — a workflow, an agent, a tool connection all belong to the org's account, not personally to whichever employee built them. Two concrete things this fixes: (a) a workflow survives an employee leaving the company, ownership never left with them; (b) a tool connection (Slack, Google, etc.) authorized by one member can be used by any other permitted member's workflows, since the connection belongs to the tenant, not the person who clicked "allow."
- **Owner is separate from any assignable role, permanent to the tenant's creator (or an explicit deliberate transfer).** Owner-only actions: billing, transferring account ownership, deleting the account. Never grantable through a role, including Admin — too consequential to hand out by accident.
- **Permission model: a fixed set of ~10 concrete toggles, not an open-ended policy language.** Create workflow / edit workflow / view workflow (read-only) / approve at a HumanApproval node / review a self-heal replacement post-hoc / manage tool credentials / set-or-change a workflow's budget cap / invite-remove members and assign roles / view billing / change data retention settings (added in Section 18, owner-admin tier). Deliberately bounded and closed, not AWS-IAM-style wildcarded resource policies — avoids a well-known real-world source of misconfiguration in that class of system.
- **Predefined roles (Admin, Editor, Viewer, Approver, etc.) plus custom roles, same data model underneath both.** A role is just `{name, set of the 9 permissions}` — predefined roles are shipped presets of that shape, a custom role is the owner naming their own combination. One simple model, not two systems.
- **Custom roles are private per tenant**, following directly from the tenant-isolation wall already locked (Section 2) — never visible or shared across different companies' accounts.
- **Single-person accounts are unaffected by any of this** — the owner has full power from day one, role system only becomes relevant the moment a second member is invited.
- **Amended 2026-09-29 (Havish, decision D7).** v1 ships the fixed roles only (tenant owner; workspace admin, editor, operator, approver, viewer); custom roles are deferred, and the name-plus-permission-set model keeps them addable. See §34 D7.

## 16. HumanApproval node mechanics (locked)

Closes gap #2 from the pre-microarchitecture review. Complements Section 14 (HumanApproval exists as a node type) and Section 15 (approving is one of the 9 role permissions — any member holding that grant can act, not only the owner).

**Four modes, configurable per approval node, not one global rule:**

1. **Always block** — run pauses indefinitely until a permitted human acts. Safest. Correct for one-off or low-frequency workflows; does not scale with volume or absence (a recurring workflow accumulates unanswered approvals while nobody is watching).
2. **Auto-approve** — never actually asks. Kept as a real node rather than deleted, deliberately: every run is still recorded as "auto-approved by policy" so the audit trail stays complete, and the node can be flipped back to blocking later without redesigning the workflow.
3. **Auto-reject / skip on timeout** — waits a configured window, then skips that step (the rest of the workflow continues) and flags the run for later human review. Protects against pile-up; accepts the risk of missing something time-sensitive.
4. **Approve once, always allow (promotion)** — starts as always-block; after a consistent run of manual approvals, the node can be promoted to auto-approve. Same node, same workflow, nothing rebuilt.

**Promotion is suggest-then-human-confirms, never silent** — Alter may notice the pattern ("you've approved the last N in a row") and offer the promotion, but the switch itself is always the user's explicit action. Consistent with the same principle already locked in Section 8 (materiality pushback: Alter surfaces judgment, the human decides) and Section 4 (self-heal notifies rather than silently deciding what a human should see).

**Still open inside this section:** how a pending approval actually reaches the person — push notification, email, in-app dashboard badge, or some combination. Not yet decided; does not block component architecture, but must be settled before the approval flow is built end-to-end.

**Amended 2026-09-29 (Havish, decision D5).** All four modes are built. Each approval step's main control is a two-choice switch set by a person with approval rights: "Ask me first" or "Always go ahead" (auto-approve, recorded as approved by policy); skip-on-timeout and the promotion suggestion (after 10 consecutive approvals, suggested, never applied without a person) are further settings. "Always go ahead" may be set on a step that acts outside Alter only through an explicit confirmation naming the consequence, recorded with who and when. The open question above is settled: pending approvals reach the approver in-app (bell, Action Centre) and by email (per-user preference, on by default for approvals); WhatsApp later. See §34 D5.

## 17. Proactive improvement (locked): notice and suggest, never act

Closes gap #3 from the pre-microarchitecture review. Everything locked before this was reactive — self-heal fires on failure (Section 4), edits happen when the user asks (Section 8), verification catches problems after a run. This covers Alter noticing, absent any failure, that a working workflow could simply be better.

- **Alter surfaces the suggestion with its reasoning; the user decides. It never silently edits a working workflow.**
- **What it can notice** (examples, not an exhaustive list): a node consistently succeeding on a heavier model tier than the task needs; two nodes always running in sequence with no real data dependency between them, so they could run in parallel; the same failure being auto-healed the same way repeatedly, indicating the underlying design should change rather than being patched every time.
- **Why not auto-apply-then-notify, even though self-heal works that way (Section 4):** self-heal fires when something is *already broken*, where doing nothing is the worse outcome. Proactive improvement touches a workflow that is currently working fine — silently editing something that works is a different and higher risk class. The asymmetry is deliberate.
- **No new component required.** Drift Detector already watches live performance and decays stale policy scores; this gives it an outbound suggestion path to the user, in addition to its existing inward path to the Policy Store.
- **Consistent with the pattern now used everywhere in this design** — Section 8 (materiality pushback on overrides), Section 16 (approval-promotion suggested, human confirms), Section 4 (self-heal notifies rather than deciding what a human should see). Alter surfaces judgment; the human holds the decision.

## 18. Data retention & deletion (locked, except run-history expiry)

Closes gap #4 from the pre-microarchitecture review. Directly reacting to the old build's worst audited finding: its right-to-erasure flow deleted from 19 tables, verified against those *same* 19 tables, found nothing remaining, and certified the deletion complete — while personal data, secrets, and user content survived in ten tables it never touched. The verification was self-referential: it confirmed what it deleted, never what existed. That is a false compliance attestation, worse than a deletion known to be partial.

**Employee (member) account deletion — audit records survive, and this follows from an existing rule rather than being a carve-out.** Audit records are the *organization's* records of actions taken in the org's system on the org's workflows — not the individual's personal property. Same principle as Section 15: resources belong to the tenant, not the member who created them. An employee leaving no more takes the audit trail with them than they take the workflows they built. The owner can still see what that member did, linked to them.

**Two different events, deliberately handled differently:**
- *Owner offboards a member* — routine; audit records survive intact and attributed.
- *Member personally demands erasure of their own data* — a real legal request; strip personally identifying details (real name, email) but keep the record under a stable pseudonymous identifier, so the chain of who-did-what stays intact and verifiable while the person is no longer personally identifiable.

**Owner deletes the whole account — delete-now, minimal-retain-briefly.**
- Everything user-facing is destroyed immediately: workflows, agents, tool connections, run history, conversation threads, cached results.
- The audit log is *minimized*, not kept whole — event skeleton only (what happened, when, under which identifier; no content, no payloads) — held for a defined retention window (30 or 90 days, set by the compliance target being aimed at), then genuinely destroyed.
- The deletion screen states exactly this, plainly, before confirmation.
- **Why not wipe the audit log instantly on owner deletion:** the log's purpose is evidence about what happened, including actions an owner might prefer unrecorded. If account deletion erases it outright, the person with the strongest motive to destroy it is the one holding the button. The retention window balances that against the owner's genuine right to erasure and the liability of holding data forever.

**Structural fix so the old bug cannot recur — this is a design requirement, not a discipline reminder:**
- The set of data to delete must be **derived from the live schema at runtime** — enumerate every table carrying a tenant identifier, and fail loudly on any table not explicitly marked either in-scope or exempt. Never a hand-maintained list; a hand-written list against a growing schema already drifted once and will again.
- **Verification must check what still exists, not re-check what was just deleted.** The old failure was a verifier iterating the same incomplete list the deleter used.
- Fail-closed, consistent with Section 5: if erasure cannot be fully confirmed, it must not report success.

**Amended 2026-09-29 (Havish, decision D2).** The audit-skeleton window is **90 days**. Records the law requires kept longer (tax invoices and billing, books of account, seller KYC and payouts) move to a minimal legal-hold store and are kept for exactly the prescribed period, then destroyed; staff access logs follow the 90-day window. Deleting a **workspace** is not immediate: it enters a pending-deletion state (hidden, triggers paused, restorable by an owner or admin) for a configurable window, default 7 days, then its data is erased by the schema-derived path above. See §34 D2.

**Run history expiry — user-configurable from day one, deliberately scoped in now rather than revisited later.**
- The user sets their own retention window; the expiry mechanism is identical whether the number is fixed or chosen, so making it configurable up front costs almost nothing and avoids a second pass over this area.
- **Bounded range, not a free-form number.** A floor (a run's records must outlive the window in which anyone — the engine or a human — might need to inspect, verify, or review it; roughly 7 days) and a ceiling (unbounded retention is both an unpredictable storage cost and a standing liability; roughly 1 year), with a sane default in between.
- **Lowering the window is a destructive action, treated as one.** Dropping 90 days to 30 destroys everything in that gap the instant it is saved — that is a delete operation wearing a settings label. Requires explicit confirmation naming what will be destroyed (e.g. "this will permanently delete 4,200 run records"), and it is a restricted permission, not something any Editor can do casually.
- **This adds a 10th toggle to the permission set in Section 15:** "change data retention settings" — owner/admin tier.
- **Expiring run history does not degrade Alter's learning.** Verified outcomes feed distilled lessons into the Policy Store (Section 3), which is stored separately from raw run records — deleting old runs does not erase what was learned from them.

## 19. Onboarding & first-run experience (locked)

Closes gap #5 from the pre-microarchitecture review.

- **First login only:** text box centered (describe what you want — the product's core interaction), curated templates displayed below it, plus a step-by-step guide. Blank-slate-plus-examples rather than either extreme — the blank box alone is intimidating for a non-technical user who doesn't yet know what's possible; templates alone would make Alter read as "n8n with better defaults" rather than "describe it and I'll design it."
- **Every subsequent login:** lands on the most recent chat, or a blank slate with access to their sessions and run history. The template gallery and guide are a first-run affordance, not a permanent fixture.

**Architectural consequence:** Capability Registry must hold and retrieve reusable workflow patterns/templates from day one — consistent with what the old spec already assigned to it ("templates, workflow patterns, reusable subgraphs").

**Constraint locked alongside it — templates are hand-authored, not harvested:**
- v1 templates are a small curated set authored by the Alter team.
- Harvesting templates from real user workflows is **not** an extension of the cross-tenant abstracted pattern-learning approved in Section 2, and must not be treated as one. An abstract lesson ("summarization tasks suit fast model tiers") carries no customer-specific content. A template is a near-complete workflow shape — node structure, tool choices, sometimes prompt phrasing — materially closer to the real artifact, and harvesting one customer's working workflow into another customer's account is a different and higher risk class.
- If template harvesting is ever wanted, it requires its own explicit decision and privacy review — never assumed.

## 20. Authentication & sign-up (locked)

Closes gap #6 from the pre-microarchitecture review.

- **Managed identity provider (Auth0 / Cognito / Clerk class), never hand-rolled auth.** Grounded in precedent: the old build used a managed provider plus careful token validation, and its JWT validator was one of the few components its hardening audit called textbook-correct — algorithm pinned to RS256 at both the header check and the key-import filter (closing `alg:none` and HS256-confusion), issuer matched exactly, audience validated, expiry/issued-at/not-before all checked with bounded clock skew. That correctness came from using a real provider and validating properly, not from inventing anything. Same approach here.
- **Sign-in methods at launch:** social login (Google/GitHub class) plus email/password. Social is lowest-friction for a self-serve product; email/password is expected.
- **Member invite flow (follows from Section 15):** owner invites by email, invitee follows the link, creates their own credentials, lands in the tenant with the role the owner assigned. Each member's login is their own — never a shared credential. **Amended 2026-09-29 (D7):** the invitation record (role, workspace, status, 7-day expiry, inviter) is ours; Auth0 Organization invitations deliver the email and hosted sign-up; the first sign-in matches the invitation and creates the membership. Resend and revoke act on our record.
- **Enterprise SSO deferred** — a real later-stage need for larger organizations, not v1.

## 21. Monetization — how Alter charges the customer (locked in shape, pricing deferred)

Closes gap #7 from the pre-microarchitecture review. Distinct from Section 9, which caps what AI providers cost the *user*; this is what the customer pays *Alter*.

- **Hybrid model: base subscription + credits, plus a free tier.** Resolves the real tension — Alter's own costs are genuinely variable (model calls, sandbox compute), so a flat subscription carries margin risk on heavy users, while pure usage-based billing produces unpredictable bills that make people afraid to use the product.
- **Verified-run billing — credits are consumed by runs that actually pass verification.** A run that fails verification, stalls, or never completes does not bill. This is only honestly claimable because of Section 5: every run is verified, fail-closed, never counted as success unless actually checked. Almost nobody in this category can make that claim, because almost nobody verifies outcomes rigorously enough to know the difference.
- **Architectural consequence:** Cost Ledger must be tied to *verification verdicts*, not only to raw resource consumption — it needs to know a run's outcome, not just what it spent.

**⚠ REVISIT — deferred deliberately, flagged for a later pass:**
- **What a credit actually costs, and how many credits a run consumes, are not decided.** The user will define these values.
- **Build the full credit infrastructure now, with the numbers as configuration, not hardcoded values** — so setting real prices later is a config change, not a code change or a refactor.
- Also unresolved and worth settling in that same pass: free-tier limits and abuse protection. A free tier that can trigger real model calls is a genuine abuse vector, and the guard for it should be designed alongside the pricing, not bolted on after.

## 22. Component list — structural findings and confirmed additions (in progress)

Assembling the component list from Sections 1–21 surfaced a structural problem: an engine-only list silently dropped everything on the account/control side. The old build split this as Engine (execution pipeline) versus Platform (account/control surface); collapsing them lost real components.

**The 8 engine layers hold up** — each is derived from a mission verb and earns its place. But L1–L8 describe how a *run* flows. Much of what Sections 15–21 locked never touches a run: accounts, members, billing, sessions, deletion. Those are neither layers nor cross-cutting planes (planes are called *during* execution; these are not). They form a third grouping: an **Account/Control plane**, parallel to the engine.

**Six components confirmed as additions (2026-09-01):**
1. **Identity & Membership** — Section 15's owners, members, 10 permission toggles, custom roles, invites. Identity/Tenant Gateway *enforces* per request; nothing stored or managed them.
2. **Notification** — Sections 4, 16, 17 each assume delivery to a human (self-heal notify-after, pending approval, proactive suggestion). No component owned it — the same shape as the old build's Pattern 3, caught before code this time.
3. **Deletion & Retention** — Section 18's schema-derived erasure, verification-of-what-exists, audit minimization, scheduled run-history expiry.
4. **Connection & Credential Management** — Section 4's credential-gap bucket and Section 8's batch-ask both assume somewhere to connect, re-authorize, and revoke. Tool Gateway *consumes* credentials at run time; nothing managed their lifecycle.
5. **ADS (the store)** — Section 10's cross-workflow context must physically live somewhere. Earlier drafts listed only ADS *Client*, the accessor, and omitted the thing it accesses.
6. **Platform API / BFF** — the sole caller of the engine; engine APIs stay private.

**Of the five arguable components, two now resolved:**

7. **Side-Effect Ledger — confirmed as its own component (L6).** Records which external actions actually fired per run, so Section 4's idempotency gate has something real to check before any retry. Without it, Recovery retrying a partially-completed workflow re-fires already-completed steps (writes the same row twice, sends the same message twice) — the recovery system becomes the thing that breaks the run. Considered folding into Blackboard, since side effects are arguably per-run context; rejected because the old design explicitly warned against Blackboard becoming long-term storage, and these records carry compliance weight (evidence of real external actions) that scratch context does not.

8. **Approval state — split by nature, engine owns facts, Platform owns presentation.** The engine holds the durable decision record (who approved, when, under which of Section 16's four modes, promotion history) because that is execution evidence feeding the audit chain and Section 16's promotion logic — it must not live outside the engine. The human-facing "what's waiting on me" inbox, which spans runs and workflows, is a **Platform-side read model** built on top of that record, not an engine component. Note: Sections 14–16 previously settled approval *behavior*, *permission*, and *node type* — storage ownership was never decided until now.

9. **Agent Factory — confirmed as its own component (L4), reversing the old spec.** The old spec folded agent auto-creation into Selection & Binding (feature 22). Separated here for one decisive reason: **it has two callers in different layers.** Selection & Binding calls it on the design path when no existing agent fits; Recovery Policy Engine calls it on the run path during self-heal (Section 4). A capability invoked by two different layers cannot live inside one of them without the other reaching sideways through it — precisely the cross-layer coupling that blurred ownership boundaries in the old build. Secondary reasons: selection is *search* (score existing candidates) while creation is *authoring* (define role, write instructions, choose model and tools) — different jobs sharing only inputs; and Section 1 names live agent creation one of only two genuinely unproven pieces in the product, so it warrants its own folder, spec, and definition of done under Section 6 rather than being a subsection of another component's.

10. **Billing & Subscription — confirmed as its own component, but built later.** Kept separate from Cost Ledger because they answer different questions: Cost Ledger answers "what did this cost us" (internal, per-run, per-node engineering data), Billing answers "what does this customer owe, what is their credit balance, are they past the free tier, did their payment fail" (financial-correctness stakes, different lifecycle). Old build kept them apart for the same reason.
    - **Deferred to a later build phase**, consistent with Section 21 parking pricing values.
    - **But one hook cannot be deferred:** Section 21 locked verified-run billing, so **Cost Ledger must record verification verdicts alongside cost from day one**. If that linkage is missing early, adding billing later requires backfilling data that was never captured.

11. **Workspace & Session Management — split by nature, same pattern as approvals.** Section 10 locked both a display concern and a real engine concern, and they separate cleanly:
    - **Engine owns** the workflow-ownership and grouping facts, because Section 10 also locked cross-workflow context: ADS Client's retrieval scope spans all of a user's workflows. That makes session/workflow membership a **retrieval boundary the engine actually reads**, not just display metadata.
    - **Platform owns** presentation — sidebar, folder display names, ordering, search UI, "Ungrouped" bucket.
    - **Decisive reason:** if the whole thing lived on the Platform side, the engine would have to read Platform storage to answer "what else has this user built," inverting the dependency direction. The Platform is a client of the engine; the engine must never depend on it. That inversion is very hard to unwind once code exists.

**All five arguable components now resolved.** Group A (twelve components added during list assembly) is fully confirmed.

**Two ownership assignments confirmed:**

- **Pre-flight budget gate is owned by Run Manager**, not a separate component. Run Manager already owns the decision "does this run start"; a spend check is exactly that kind of decision at exactly that moment, and a separate component would add a network hop for one boolean on the hottest path. **Hard requirement in its contract:** the budget check must be *atomic* against the budget record, not read-then-decide — otherwise Section 4's known race (two parallel runs both pass the check, together exceed the cap) is unhandled by construction.
- **Policy Store has two scopes: tenant-local and global.** Required by Sections 2 and 3 together — cross-tenant abstracted learning was approved, and Policy Store is the home for learned policy, but it was originally designed per-tenant only. **The global tier must be structurally incapable of holding tenant-specific content** — enforced by schema and by what the write path physically accepts, so a mistake fails loudly rather than silently leaking one customer's specifics into every tenant's policy. Same reasoning as Section 18's schema-derived deletion: a hand-maintained discipline against a growing system drifts eventually.

**Two further structural findings, not yet decided:**
- **The engine has two distinct paths, not one linear pipeline.** Design path (L1→L2→L3→L4→L5): a human describes something, Alter designs and compiles it — runs once per workflow creation or edit. Run path (L1→L6→L7→L8): a trigger fires, an already-compiled workflow executes — runs thousands of times, never touching Planner or Architecture Synthesizer. Recovery's replan is the only jump from run path back into design path. Presenting L1→L8 as one pipeline wrongly implies every run passes through the Planner.
- **Project Mode was never scoped.** The old PRD had two modes: Workflow Mode and Project Mode (build/test/deploy real software). Every discussion in this log has assumed Workflow Mode. Project Mode would roughly double scope, heavily expand Sandbox and Provisioning, and require a second verification shape (build passes, tests pass, renders correctly — unlike "did the message send"). Undecided.

## 23. Project Mode (locked): out of scope for v1, planned for a later version

The old PRD had two modes on one engine: Workflow Mode (business automation, competes with n8n) and Project Mode (build, test, audit, deploy, and maintain real software — competes with Lovable/v0/Bolt). **Project Mode is deliberately out of scope for this rebuild's first version, and planned as a feature for a later version of the engine.**

**Why it needed an explicit decision rather than being assumed in:** Section 1 lists "AI Application Development Framework" as a use-case class, but that entry describes building sophisticated *nodes* — custom memory, RAG pipelines, multi-step reasoning — which is Workflow Mode with capable components. It is not the same as delivering a deployed application. Every decision in Sections 1–22 was made against Workflow Mode: the lead-capture example, the verification design ("did the external system actually change as claimed"), the Classify buckets, approval nodes. None of it was designed against "did the build compile and the tests pass."

**What deferring it avoids for now:**
- Sandbox and Provisioning stay supporting components rather than becoming major ones (code execution, package installs, build/lint/render verification, persistent sessions, artifact storage).
- Section 5's verification does not need a second shape. Software delivery needs build-passes / tests-pass / renders-correctly / no-placeholder-code / deploys-successfully — a different mechanism from mechanical-plus-semantic node checking.
- No deployment target question (where does a built app live, who hosts it, what happens when it breaks in production).
- No second success metric or second UX surface.

**Decisive reasoning:** Section 1 already names two genuinely unproven R&D pieces within Workflow Mode alone — reliable autonomous topology design, and live agent creation mid-failure. Adding a second mode roughly doubles surface area before either is proven working once. That also directly contradicts Section 6's locked build philosophy (component-by-component, each verified against real execution before moving on).

**Architectural requirement so this stays addable:** keep Sandbox and Provisioning in the component list, scoped small. Project Mode must remain a later addition, never a rearchitecture. Do not design it out.

**Amended 2026-09-29 (D13, from D-23a).** Project Mode code is present (plan-then-execute project skeleton, project run provisioning, Project Studio) but not offered in the v1 interface. It stays in the code; it is not designed out.

## 24. Two-path engine model (locked): design path and run path

The engine is **not** one linear L1→L8 pipeline. It has two distinct paths through the same components, connected at exactly one point.

- **Design path (L1 → L2 → L3 → L4 → L5).** A human describes an objective; Problem Understanding structures it; Planner and Architecture Synthesizer decide what system should exist; Capability Fabric binds concrete implementations; Graph Compiler produces a versioned WorkflowDAG. Runs **once per workflow creation or edit**. Reasoning-heavy, slow, expensive — and that is acceptable, because it is rare.
- **Run path (L1 → L6 → L7 → L8).** A trigger fires; Run Manager queues it; Executor walks the already-compiled graph; gateways do the work; Verification checks each node and the final outcome. Runs **thousands of times**. Never touches Planner or Architecture Synthesizer — the design is already decided and stored.
- **Single crossing point:** Recovery's `replan` / `recompile` strategy (Section 4) jumps from the run path back into the design path when a failure indicates the workflow's *design* is wrong, not just its execution.

**Why this matters beyond diagram accuracy:**
- A single-pipeline reading implies every run passes through the Planner. That would be absurdly slow and expensive — the equivalent of rewriting the recipe from scratch every time you cook.
- It changes what "layer" means for the component contracts: L6/L7 components are invoked constantly and must be fast and sturdy; L3 components are invoked rarely and can afford to be deliberate. Their blast radius, fail mode, and performance requirements differ accordingly, and writing all contracts against one uniform pipeline assumption would give both the wrong shape.

## 25. Public Surface (locked): its own component, separate from Event & Trigger Gateway

Section 1's own lead-capture example requires Alter to host a **public web form** — a page reachable by strangers with no Alter account. Same class of thing as a public webhook endpoint that an external system (Stripe, a CRM) posts into.

- **Confirmed as its own component**, not folded into Event & Trigger Gateway.
- **Reason 1 — different work.** Event & Trigger Gateway *receives and normalizes* inbound signals into canonical Alter events; that is backend routing. A hosted form must *serve a rendered page to a browser* — different technology, different failure modes.
- **Reason 2, decisive — blast radius.** This is the only surface anonymous, unauthenticated traffic touches directly. It needs its own boundary, its own rate limiting, and its own blast-radius declaration. If the public endpoint is flooded, that must degrade public form submissions only — not the trigger system that also serves scheduled and internal triggers.
- **Distinct from Platform Web**, which is authenticated (log in, see your own workflows). Public Surface is deliberately the opposite: no login, anyone with the link, untrusted input by definition.
- Consequently it is a primary consumer of the Safety & Policy shared library (Section 11) — untrusted input handling, injection defense, upload rules.
- **Amended 2026-09-29 (Havish, decision D16).** Built for v1 as an **option**, not the default: users normally connect their own input (form tool, CRM, site) by connector or webhook; the hosted form is offered as one choice when setting up a submission trigger. Minimal: fields on the trigger, public link, Cloudflare Turnstile, per-form and per-visitor rate limits, D15 input checks, no uploads in v1, own process. See §34 D16.

## 26. Naming (locked): kill the "session" collision

"Session" meant two unrelated things in the same component list — auth session (who is making this request) and chat session (one workflow's conversation thread, Section 10). Same word, different concepts, both live in the architecture. That is how a component gets wired to the wrong thing by a later reader, and it is the same class of quiet ambiguity that produced the old build's duplicate-primitive drift (Section 7, pattern 4).

**Renames, binding across all documents and code:**
- L1 `Session/Tenant Gateway` → **Identity & Tenant Gateway**
- Account plane `Workspace & Session Management` → **Workspace & Workflow Management**

Neither name uses "session." Both describe what the component actually does. Earlier sections of this log that use the old names refer to these components.

**Amended 2026-09-29 (Havish, decision D17): renamed when touched.** New code and documents use the new names; existing occurrences are renamed when their file is edited for another reason; a CI gate blocks the old name in added lines. See §34 D17.

## 27. Platform Web subdivision (locked): five surfaces

"Platform Web" as a single component was too coarse to contract — no single input, output, or blast radius across chat, canvas, sidebar, approvals, admin, settings, connections, and billing. Split into five surfaces, each with a coherent job and its own definition of done:

1. **Chat & Workflow Builder** — the primary interaction: describe a workflow, watch it get built, converse about changes.
2. **Canvas** — the visual graph: view, structural drag-editing, opening a node to override internals, materiality pushback and impact analysis (Section 8).
3. **Run Monitor** — live run watching, per-node verification results, run history.
4. **Approval Inbox** — "what is waiting on me" across all workflows; the Platform-side read model over the engine's approval decision record (Section 22).
5. **Account & Admin** — members, roles, connections, budgets, retention settings, billing views.

**Build order follows Section 6, not a UI block.** These five are not built together — each surface appears incrementally as the backend it exercises becomes real. Canvas cannot exist before Graph Compiler produces a real DAG; Approval Inbox cannot exist before the approval record does.

**Noted reservation:** the seam between (1) and (2) is the softest of the five — in practice they share one screen, chat on one side, graph on the other. Kept separate because Section 8 gives the canvas substantial independent behavior with its own definition of done, and sharing a viewport is not the same as being one component. Revisit if the boundary proves artificial in practice.

## 28. Deletion registration rule (locked): extends Section 18 across components

Section 18 required erasure to be schema-derived rather than working from a hand-maintained list. That was written against a single-database picture. With 50-plus components, many holding tenant data in their own stores, the rule extends: **every component that stores tenant data must register with Deletion & Retention, enforced structurally rather than by discipline.**

1. **Declaration.** A component holding tenant data declares what it holds and how to erase it.
2. **Fail-closed certification.** Deletion & Retention refuses to certify a deletion complete if any component holding tenant data has not registered. Consistent with Sections 5 and 18 — never report success that was not verified.
3. **CI enforcement.** The build fails when a component stores tenant data without a registration. The gap is caught at commit time, not discovered during a real erasure request.

**Part 3 is the load-bearing one.** The old build's failure was not carelessness — the deletion list was correct the day it was written. Ten tables were added over the following months, each by someone building an unrelated feature, none thinking about erasure. The list went stale silently while the system kept certifying deletions as complete. Care cannot prevent that, because care is what already failed; only an automated check can. Same reasoning as Section 7's driver-exists tests and Section 11's single-source-of-truth library.

## 29. Open items — not yet decided, need to revisit

- Classify bucket list (Section 4): explicitly flagged by the user as provisional — expect refinement once real testing surfaces failure modes not yet imagined. Revisit after first real test runs, don't treat the current 5-bucket list as final.
- Blast-radius / fail-mode contract per component (from earlier discussion): every component needs a declared blast radius (nothing/degraded/this-layer-only/whole-engine) and fail mode (fail-closed vs fail-open-and-logged) before code is written. Not yet applied to any specific component list.
- **Credit pricing and free-tier limits (Section 21)** — user will define; infrastructure built now with values as configuration.
- **Approval notification delivery (Section 16)** — how a pending approval reaches the person (push / email / in-app badge). Doesn't block architecture; settle before building the approval flow end-to-end.

## 30. Service-to-service authentication (locked 2026-09-08)

Sections 15 and 20 settled how a *person* is authenticated. Nothing settled how one internal service authenticates to another, and that omission is what stalled the healing loop: Memory & Learning authenticates its caller with the shared internal service token, then forwards that same header to an orchestration endpoint that derives tenancy from an actor context only a user token can produce. Memory cannot mint one — #113 removed the Auth0 `organization` parameter because an Alter tenant UUID was never a valid namespace there. **A cycle across an authentication boundary, which is why no single credential closes it.**

**The rule: an internal service endpoint accepts an explicit tenant alongside a service credential.** Internal services are legitimately called on behalf of many tenants by a trusted caller, so banning a message-borne tenant is the wrong instinct — it is right for a user-facing edge and wrong here. The real defect was never that a tenant travels on the wire; it is that nobody checked whether the caller was entitled to assert it.

**Three requirements, and the second and third are what make the first safe:**

1. **Authenticate the asserter.** The caller proves it holds the service credential before anything it says is acted on.
2. **Verify the assertion against data we already own.** The asserted tenant must match the tenant the addressed resource actually belongs to. Where a mismatch is currently absorbed as an empty result, it must instead refuse explicitly with a named reason — consistent with Section 5's fail-closed rule, where silence is never a pass.
3. **Audit every service-asserted tenant.** The credential is the weak point; the trail is what makes a leak recoverable rather than unbounded.

**The limitation, stated rather than hidden.** Every service currently presents the *same* shared token, so this authenticates *that the caller is an Alter service*, not *which one*. Section 2's tenant isolation therefore rests on that shared secret plus requirement 2's data-level check. That is acceptable now and it is not the end state: when per-service M2M applications exist, the asserter check tightens to RS256 verification and every call site stays unchanged.

**Amended 2026-09-29 (Havish, decision D1): background jobs use a system caller, not the shared token.** Platform work that runs with no user signed in reaches the engine on the existing two-token path: the identity broker mints the short-lived, single-use actor token for a named system principal (`system:platform-jobs`) instead of a user, bound to one tenant, carrying a fixed read-only permission set, and the engine validates and audits it like any call (recording the principal type). The shared-token internal-endpoint pattern above stays for service-to-service calls that already use it; it is not extended to platform jobs. See §34 D1.

## 31. Agent creation must not manufacture a doomed agent (locked 2026-09-08)

Section 22 item 9 gave Agent Factory its own component. This section settles what it does when the requirement it is asked to satisfy is one policy will not allow.

- **Never create an agent that cannot satisfy the requirement that triggered its creation.** The old behaviour hardcoded a tier while eligibility filtered on that same column, so an unmet tier requirement produced an agent that failed the same filter. That is not a cost defect, it is a correctness defect: the failure surfaces several steps downstream, where the cause is no longer recoverable.
- **When the requested tier exceeds policy, fail the bind with a named reason** — no eligible agent, and creating one would exceed the tier policy. Making the failure visible is the point; substituting a cheaper agent hides it.
- **The tier ceiling is configuration, not a constant.** A deployment value, defaulting to the standard tier, raisable. Section 9's pre-flight budget gate is the better long-term control — spend caps address the actual objection to unbounded tiers, which is cost — and the ceiling should be lifted deliberately once that gate exists rather than left in place by inertia.
- **Creation is idempotent per tenant, workspace and capability set.** This is independent of the tier question and is not a policy decision at all: without it a retrying caller writes a row per attempt, so three identical requests permanently add three agents. Treat it as a defect to fix immediately rather than an item waiting on any decision.

## 32. Stored derived data comes from the decision already made (locked 2026-09-08)

When a component persists something another component already decided, it copies that decision rather than re-deriving it. Re-deriving produces a second answer to one question, and two answers drift — Section 7's fourth systemic pattern.

Concretely, the architecture compile path writes an empty node-requirements map where the task-skeleton path resolves a real one. The caller already supplies that map; the path simply fails to persist what it was handed. Copy it.

**The residual problem, recorded rather than hidden.** Filling that column correctly still leaves the system with two sources for one fact: the stored map, and the fresh resolution the Executor and Recovery each perform at run time. That *is* pattern 4, arrived at from the other direction. The clean resolution is for run-time consumers to read the stored value rather than re-resolve, making it the single source of truth — or for the column to be deleted as redundant. **That decision is deferred, not answered**, because it touches components that are deliberately frozen during revival. It must not be forgotten: a correct value in a column nothing reads is still two answers waiting to disagree.

**Amended 2026-09-29 (D13, from D-32a): closed.** The residual was answered on 2026-09-14 by deleting the write-only `node_requirements` and `policy_bindings` columns.

## 33. Voice and Repository Manager: cut from v1 (locked 2026-09-08)

Both were declared as contracts with nothing behind them. Both are cut from the first release, deliberately and in writing, following the same reasoning Section 23 applied to Project Mode: an explicit cut is reversible, an ambiguous one compounds.

- **Voice.** Six RPCs declared, no implementation, and no telephony vendor anywhere in the repository. Confirmed separately that no other product in the portfolio depends on this engine for voice, so nothing outside the engine argues for keeping it. It was never in this design log at all — unlike Project Mode, which was deferred explicitly.
- **Repository Manager.** Declared, never implemented, and unlike Deployment Manager it has no backend contract to build against. Nobody has stated what it is for.

**Cutting means removing or deprecating the declaration, not writing a note.** A contract that remains generates clients, appears in counts, and sits inside every estimate of remaining work — which is the cost that made this worth deciding at all. If either returns later it returns as a scoped addition with a named vendor or a written purpose, never as a rediscovered obligation.

**Amended 2026-09-28 (Havish): the Repository Manager returns to v1, standalone.** It returns exactly as this section required — with a written purpose and a named vendor. **Purpose:** a workspace links GitHub repositories reachable through its own GitHub OAuth connection and reads their branches and open pull requests. **Vendor:** GitHub, through the existing OAuth Hub connector (scopes `read:user repo`), so no GitHub App is introduced. **Scope boundary:** read-only against GitHub; bindings store identifiers, never tokens; no repository creation, transfer or write — those belong to Project Mode, which stays out of v1 (§23). Voice stays cut.
---

## 34. Owner decisions of 2026-09-29

Havish answered every open product question in one sitting, one question at a time, each put with options and an attacked recommendation. The full record (question, options, answer, consequence) is `../decisions/2026-09-29-owner-decisions.md`; this section is the binding summary, and sections a decision changes carry an "Amended 2026-09-29" note pointing here.

- **D1. System identity for background jobs: system caller on the two-token path.** A named principal `system:platform-jobs`, one tenant per token, fixed read-only permissions, short-lived and single-use, audited as a system principal. Unblocks engine-originated notifications, budget alerts, drift suggestions and self-heal notices. Amends §30.
- **D2. Retention.** Audit skeleton 90 days after tenant deletion; legally required records (invoices and billing, books of account, seller KYC and payouts) held in a minimal legal-hold store for exactly the prescribed period; staff access logs 90 days; everything else destroyed immediately. Workspace deletion has an undo window (pending deletion, default 7 days, configurable), then erasure. Amends §18.
- **D3. Budgets.** Engine-owned budget records, atomic check-and-reserve in Run Manager at run start; per-run cap, per-workflow daily/monthly, per-workspace monthly; alerts at 50% and 80%; hard stop by default, per-budget warn-only option. Amends §9 and settles §22's budget ownership.
- **D4. Pre-run estimate.** Usual cost from the last 5 verified runs plus a worst-case bound from the compiled DAG; reserve the worst case at run start, true up at the end. Cost Ledger freeze exemption granted for the per-workflow cost read. Amends §9.
- **D5. Approvals.** All four §16 modes; main control "Ask me first" / "Always go ahead", set by a person; "Always go ahead" on external-action steps only with an explicit, recorded confirmation; promotion suggested after 10 consecutive approvals; delivery in-app plus email. Amends §16 and the add-never-remove safeguard rule for this one case.
- **D6. Chat.** One workflow = one chat (builder pipeline). Plus a read-only "Ask Alter" assistant per user: updates and answers across workflows from what the user can read; its only action is starting a new workflow and handing off to that workflow's chat. Amends §10.
- **D7. Members.** Hybrid invites (our record, Auth0 delivers, matched on first sign-in, 7-day expiry, resend/revoke); members screen shows the five enforced roles; fixed roles for v1, custom roles deferred. Amends §15 and §20.
- **D8. Success criteria.** Shown and editable on the plan step; Build confirms them; an uncovered criterion fails loudly. Amends §5.1.
- **D9. Folders and context.** Engine-owned simple folders with an Ungrouped bucket; cross-workflow context stays inside the workspace. Amends §10.
- **D10. Workflow health.** Validation, availability, correctness, reliability over the last 20 runs or 7 days; overall = average; status set by the worst dimension (critical <50, warning <80); "not enough data" with no runs.
- **D11. Event replay.** Replay is a dry run (Simulate on the stored event) by default; "Replay for real" is separate, confirms the outside actions it will repeat, and records who confirmed.
- **D12. Memory settings.** Chat, workflow and workspace memory switches (on by default) enforced by memory-service; retention 7-365 days, default 90; no "allow sensitive data" in v1, memories always PII-redacted.
- **D13. Track D amendments accepted.** §4 ten classes mapped to the five buckets, retry once then swap, classes added for target-missing and ambiguous; §7 pattern 1 by gate and RUNTIME_MODE; §23 Project Mode present, not offered; §32 closed by deletion.
- **D14. Read-back.** Email: pass on acceptance, SES delivery events flag later bounces and notify. Clicks: snapshot only when the step declares the expected page state, otherwise "unconfirmed". Amends §5.2.
- **D15. Safety library.** One implementation per language plus a CI parity test on a shared case set; the duplicate-safety gate narrowed to real duplicates. Amends §11.
- **D16. Public form.** Minimal hosted form offered as an option beside connecting the user's own input; Turnstile, rate limits, input checks, no uploads, its own process. Amends §25.
- **D17. Rename.** "Identity & Tenant Gateway" in new code; old name renamed when a file is touched; CI blocks it in new lines. Amends §26.

---

## Status as of 2026-09-01

**Product-level design: complete.** Seven pre-microarchitecture gaps closed (Sections 15–21), earlier architecture-level items closed (Sections 11–14).

**Component list: settled.** Group A (12 components added during list assembly) confirmed in Section 22. Group B (2 ownership assignments) confirmed. Group C (6 structural questions) resolved in Sections 23–28: Project Mode deferred to a later version, two-path model accepted, Public Surface separated, "session" naming collision fixed, Platform Web split into five surfaces, deletion registration rule enforced in CI.

**Component contract template agreed** — each component gets: name/layer/purpose, input (from which named component), output (to which), call type (sync/async/side-channel), driver (plus the test asserting it exists), failure target, blast radius, fail mode, plane dependencies, done gate. The driver and blast-radius/fail-mode fields exist specifically to close two of the old build's four systemic patterns at design time rather than audit time.

**Remaining open items** are either deliberately deferred (credit pricing), pending real test data (Classify buckets), pending a small product decision (approval notification delivery), or blocked on writing the contracts themselves (blast-radius per component).

**Next phase:** write the per-component contracts, then layer architecture, then plane architecture, then whole-engine architecture. Nothing built yet — no code has been written, deliberately.

---

## Status as of 2026-09-08

**The build changed shape.** The ground-up rebuild this log was written for was stopped at one component of fifty-five, after a readiness assessment found twenty-five components of the existing engine working end to end. **This log is no longer a build plan. It is the standards document** the revived engine is held to — see `../memoryalter.md` for the decision and its reasoning.

**Sections 30 to 33 were derived during that revival**, not during the original design conversation. Three of them close questions this log had left open or never addressed: service-to-service authentication (Section 30) was genuinely absent, agent creation policy (Section 31) extends Section 22 item 9, stored derived data (Section 32) applies Section 7 pattern 4 to a case that had not been considered, and Section 33 cuts two components this log never mentioned.

**Two of Section 29's open items are now partly addressed.** Blast radius and fail mode per component are drafted across all sixty-one components in `../components/`, marked as proposed rather than ratified, and are to be replaced by the values in `component-contracts.md` where the two describe the same component. The Classify bucket list remains provisional as written, pending real test data.
