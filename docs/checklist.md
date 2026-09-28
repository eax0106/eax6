# checklist.md — Project Revive

Terse list of work. **Numbering follows `action-plan-v1.html` exactly**, so this document,
the action plan and the team all use one vocabulary. Reasoning for every block lives in
[`memoryalter.md` §3](memoryalter.md#3-checklist-context).

**Finish line.** One real business problem in; topology designed; run executed; outcome
verified against real external systems; one node deliberately broken, then detected,
replanned, recovered, remembered, and its drift score readable by the owning tenant —
watched on a screen, not described in a report.

Status: `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

**Two additions to the action plan, marked `[+]` wherever they appear.** Task 1.0 and all
of Track C are ours, not the plan's. They are called out rather than folded in silently.

---

## Phase 0 — answer five questions. No code.

*Days · Havish only. Written answers are the deliverable — a paragraph each. Three of the
five block later phases outright.*

**PHASE 0 CLOSED 2026-09-08.** Every decision is also written onto the component pages it
affects, which is how the plan's "linked from its issue" gate is met — `alter-x-4-` is
frozen and never written to.

**Closed:** All five answered with rationale in
[`phase-0-decisions.md`](phase-0-decisions.md); derived logic appended to the design log as
§30–§33. No code changed.

- [x] **0.1 memory credential** — *blocks Phase 2.* Memory forwards its caller's token to
      an endpoint that derives tenancy from the token itself, and minting a tenant-scoped
      one is off the table since #113. Either that endpoint accepts a tenant explicitly
      alongside a service credential, or the cycle stays.
- [x] **0.2 recovery contract** — *blocked Phase 2.* **Closed 2026-09-08 from design log
      §24: `TaskSkeleton` is canonical.** Replan re-enters the design path, and L5 is what
      produces the DAG, so replan must hand back what that path consumes. Implementation is
      task 2.2.
- [x] **0.3 auto-creation tier** — *blocks Phase 3.* Issue #125. Creating at the requested
      tier converges but lets any caller conjure a `CEILING`-tier agent. **The action
      plan's own read: refuse above a ceiling — safer, and makes the failure visible.**
      Design log §9's pre-flight budget gate offers a third option (create at the requested
      tier, bound abuse with spend caps). Pick one.
- [x] **0.4 requirements map** — *latent.* Issue #117. Who fills `node_requirements` on the
      architecture path — the compiler by re-resolving, or the caller who already decided?
      Nothing reads the column today, so this can wait, but not indefinitely.
- [x] **0.5 action vocabulary** — *blocked a platform item.* **Closed 2026-09-08 from
      design log §22 item 8: the engine's enum is canonical, the platform moves.** The
      approval inbox is a Platform-side read model over the engine's decision record, and a
      read model maps onto its source. Implementation is task B-vocab.

**Done when** five written answers exist, each with its rationale, each linked from its
issue. No code has changed.

**Also open, not in the action plan:**
- [x] **0.6 [+] Voice and Repository Manager scope.** Cut or scope both explicitly. Until
      then they distort every count. (The plan handles these in Phase 5; this is the
      decision that gates that phase.)
- [x] **0.7 [+] Architecture docs status.** Are `component-contracts` (2,100 lines),
      `layer-architecture`, `plane-architecture` and `whole-architecture` binding standards,
      or superseded by the design log?

---

## Phase 1 — buy and wire the two providers

**PHASE 1 CLOSED 2026-09-28.** 1.0–1.6 all done; the phase's done-when was met on 2026-09-09 and its last reproducibility gap closed with PR #19.

*1–2 weeks · highest leverage in the plan.* Eight components are judged "works, quality
unproven" purely because the local mock answers everything. It has already produced three
false readings.

- [x] **1.0 [+] prove the stack runs, and keep it running.** **CLOSED 2026-09-08.** 47 ports,
      26 services, all answering; a real two-node workflow dispatched through the real
      Executor with upstream output reaching the second node; a service stopped on purpose
      and the failure seen. Produced two findings beyond its brief — a permission bit that
      silently disabled a LocalStack init script, and the `ALTER_CONFIG_SOURCE` contradiction
      that stops platform-api starting from committed config. Its regression check is
      committed but **not yet wired** — see C16.
- [x] ~~**1.0 (was in progress)**~~ Not in the action plan —
      #122/#123 already fixed the environment and the team had it up on 6 Sep. Added
      because nothing *keeps* it fixed, and the assessment names that exact mechanism as
      what produced the wrong count twice. Half a day, and it protects the phase that
      matters most: wiring real providers into a stack nobody has confirmed still starts is
      a bad trade. *Prompt issued 2026-09-08,
      [`prompts/revive-01-environment.md`](prompts/revive-01-environment.md).*
- [x] **1.1 provider account procurement. CLOSED 2026-09-09 — Bedrock, already the running
      decision, now recorded as one.** Never formally decided in writing until now, but it's
      been the actual account in continuous use since 2026-09-08: real Titan embeddings
      (task 1.2), real `qwen.qwen3-32b-v1:0` invocations, most recently task 1.5's live
      golden-set run. One AWS account, one IAM story, the only route to Titan embeddings the
      vector column is already sized for. Anthropic direct was never procured — no gap, this
      closes the decision the running system already made.
- [x] **1.2 embeddings — the quieter half. CLOSED 2026-09-08.** Titan wired behind the
      `Embed` RPC, Bedrock bypassing LocalStack with a fatal guard,
      `MODEL_GATEWAY_EMBEDDING_PROVIDER=titan` as a local opt-in that AppConfig cannot
      reach, and `PLATFORM_API_CONFIG_SOURCE` unblocking platform-api. Discrimination
      asserted through real gRPC `Embed` calls, with the mock case as an inverted assertion
      so proven-to-fail runs in CI. End to end: under the mock an unrelated request binds a
      summarisation agent; under Titan it no-matches while a genuine request still binds.
      Surfaced **C18**.
- [x] ~~**1.2 (was open)**~~ Wire `TitanEmbeddingProvider`
      (`amazon.titan-embed-text-v2:0`) behind model-gateway's `Embed` RPC. Do not skip:
      Selection & Binding and Agent Auto-Creation both depend on it, and both currently
      return nonsense that looks like success. **Two traps:** the caller must pass
      `dimensions: 512` or the DB insert fails at a distance from the cause, and
      `healthCheck()` returns healthy without probing anything (`liveProbe: false`).
      *Prompt ready [`prompts/revive-12-titan-embeddings.md`](prompts/revive-12-titan-embeddings.md)
      — needs Titan access granted and 1.0 finished.*
- [x] **1.3 AppConfig configuration + embedding provenance. CLOSED 2026-09-08.** Six Node
      services answering under `appconfig` against real AWS; provenance recorded from
      `EmbedResponse.model_id`, stale vectors excluded fail-closed, exclusions counted.
      AppConfig is a documented **opt-in** — the committed default stays `mock` so local dev
      needs no AWS credentials. **Was seven services in the prompt; eval-service never read
      the variable.** Original scope: Switch `ALTER_CONFIG_SOURCE`
      from mock to `appconfig`; create the AppConfig application, environment and profile.
      Fifteen files across seven services read it and all validate it, so it is
      all-or-nothing in one pass — **run this task alone.** **C18's now-half is folded in
      as a second commit**, because flipping to appconfig switches embeddings to Titan
      unconditionally and makes every mock-space stored vector stale. *Prompt ready
      [`prompts/revive-13-appconfig.md`](prompts/revive-13-appconfig.md) — needs an AWS
      AppConfig application, environment and profile to exist first.*
- [x] **1.4 secrets plumbing — CLOSED 2026-09-08 for the eight references it scoped.** All
      eight now resolve against real AWS, verified by `scripts/check-reference-resolution.sh`
      (names only, proven to fail, gated on credentials). audit-service and
      cost-ledger-service come up from committed configuration alone. **The gateway services
      still cannot** — they read Anthropic, Tavily and Browserbase references never committed,
      and two of those vendors are unpurchased, so it is a dependency rather than a gap. See
      **1.6**. Original scope: Task 1.3
      proved six services run under real AppConfig, but did it by hand-supplying reference
      values, because **only two of eight committed references resolve against real AWS**.
      Four point at resources that exist under a different name; cost-ledger's two point at
      nothing at all. So the path works and is not reproducible from the repository — task
      1.0's lesson, arriving somewhere else. Fix the references rather than renaming
      resources, create only what is missing, unify `APPCONFIG_APP_ID` against
      `APPCONFIG_APPLICATION_ID` (§7 pattern 4), and prove a bring-up from committed
      configuration alone. **Convention for anything new: `/alter/<env>/<service>/<kebab-case>`.**
      *Prompt ready [`prompts/revive-14-secrets-plumbing.md`](prompts/revive-14-secrets-plumbing.md)
      — needs `secretsmanager:CreateSecret` granted first.*
- [x] **1.5 re-run everything — the point of the phase. CLOSED 2026-09-09.** Real number
      obtained from a genuine clean checkout, real Docker, real AWS Bedrock (PR #8,
      `50edf30`): **21/30 passed, pass_rate 0.70.** 9 failures grouped by real cause — 7x
      Model Gateway returning invalid JSON for classification content (`INTERNAL` gRPC
      error), 2x genuine intent misclassification (`workflow`→`execute`, `execute`→`plan`).
      Not infra noise — every failure has a real, named reason, satisfying Phase 1's done
      gate. Run twice per the script's own design: run 2 hit the semantic cache (15.5x
      speedup, byte-identical output to run 1) exactly as the script's own cache-detection
      logic is built to catch — **the trustworthy number is run 1's cold 0.70, not run 2's.**
      This is Phase 1's first real post-provider score, ever — every prior number was void
      per standing rule 11. The 7x JSON-format failures are a real, distinct signal about
      model output reliability, not something Phase 1 committed to fixing — worth its own
      ticket, not chased here.

- [x] **1.6 [+] finish reproducibility for the gateway services.** **CLOSED 2026-09-28, PR #19 (`bf58fa9`): all four gateway services boot real from `.env.local.example` — `bash scripts/run-service-aws.sh <service> --check` prints `<service> boot-ok` for model-gateway, tool-gateway, sandbox-service and provisioning-service, re-run on main after merge. No purchase was needed: Anthropic/OpenAI became optional failovers, the admin-token reference was misnamed, provisioning reads no AppConfig, sandbox reads the engine-wide tool policy (version 2 adds `browser.verify_render`), and two addresses were never committed. Detail in memoryalter 2026-09-28.** audit-service and
      cost-ledger-service bring up from committed configuration; model-gateway, tool-gateway,
      sandbox-service and provisioning-service do not. **Corrected 2026-09-09 — the vendor
      list was incomplete.** Verified directly against each service's environment schema
      (`requireValue`/`required`, all gated behind `ALTER_CONFIG_SOURCE=appconfig`, none
      needed under `mock`): **five vendors, not two.**
      - `ANTHROPIC_API_KEY_SECRET_REF` — model-gateway. Required to boot even though
        Bedrock is the actual provider decision (task 1.1).
      - `OPENAI_API_KEY_SECRET_REF` — model-gateway. Never named anywhere in the record
        before now.
      - `TAVILY_API_KEY_SECRET_REF` — tool-gateway.
      - `BROWSERBASE_API_KEY_REF` + `BROWSERBASE_PROJECT_ID` — tool-gateway **and**
        sandbox-service, both required. (Previously recorded as
        `BROWSERBASE_API_KEY_REFERENCE`, the wrong name, and missing the project ID.)
      - `E2B_API_KEY_REF` — sandbox-service **and** provisioning-service. Never named
        anywhere in the record before now.

      **Blocked on those five purchases, not on engineering** — or on an explicit decision
      to cut any of them (Anthropic and OpenAI being hard-required for a service that
      never calls either provider is worth challenging on its own, separately from
      procurement). Until then the AppConfig path is reproducible for two services out of
      six, and saying otherwise would be the kind of claim this project exists to stop
      making.

      **Partial wiring done 2026-09-09 (`db4b53e`).** Checked AWS directly: Tavily,
      Browserbase (API key), and E2B secrets already exist for real. Committed and proven
      live (resolves clean, proven to fail correctly on a broken reference, restored).
      **Still blocked, three ways:**
      1. `BROWSERBASE_PROJECT_ID` — not a secret, a literal value nobody has supplied.
      2. **sandbox-service and provisioning-service have no AppConfig application at all**
         — only `alterx-engine` and `alterx-tool-gateway` exist. Creating the missing two
         is new AWS resource creation, blocked by this session's permission boundary;
         needs Havish's go-ahead or his own two `aws appconfig create-application` calls.
      3. Anthropic and OpenAI keys still don't exist anywhere in the account — unchanged
         from above.

      **`BROWSERBASE_PROJECT_ID` resolved and tool-gateway closed for real, 2026-09-10.**
      Found the real value directly in Havish's already-open Browserbase dashboard tab
      (org "Alterxtest", single project "Production project") — confirmed same account as
      the already-stored key by comparing shape (both `bb_live_`-prefixed, both exactly 35
      characters; only one Browserbase project exists in the org, so there is nothing else
      it could be), never printing the raw key. Committed
      `BROWSERBASE_PROJECT_ID=c214bf9e-3b19-4e5d-8aa4-c55472ce4669`, plain text — not
      sensitive, same as the dashboard shows it. **tool-gateway then verified with a real
      boot**, direct commands (not through Nx, task C26's fix), real AppConfig
      (`alterx-tool-gateway`/`local`/`tool-gateway-policy`), real Tavily and Browserbase
      secrets, real local M2M issuer: `Nest application successfully started`, `curl
      /health` returned `{"status":"ok","service":"tool-gateway"}` — the exact identity
      check C23 asked for, not just an HTTP 200. **tool-gateway is closed.**

      **sandbox-service and provisioning-service remain blocked** — both need an AppConfig
      application that doesn't exist yet (same gap as above, nothing new). **model-gateway
      remains blocked** — Anthropic and OpenAI keys still don't exist.

**Done when** a 30-case golden set scores above zero for a real reason; a capability
request for `underwater.basket.weaving` no longer matches a summarisation agent; and the
Conversation Manager returns different intents for different utterances.

**All three met, 2026-09-09.** Golden set: 21/30 (0.70), real reasons (task 1.5). Capability
discrimination: real Titan embeddings score `underwater.basket.weaving` at 0.12 against a
0.6 threshold vs 0.86 for the genuinely relevant capability (task 1.2). Conversation
Manager: the same golden-set run returned five distinct, mostly-correct intents
(`plan`/`modify`/`execute`/`answer`/`workflow`) across 30 different utterances, live.

---

## Phase 2 — close the healing loop

*2–3 weeks · needs Phase 0 answers 0.1 and 0.2.* Recovery, Memory and Drift land together
or the observable behaviour does not change. **Do not let these be picked up separately** —
that is how three independent-looking tickets each get closed while the product still
cannot heal itself.

- [x] **2.1 credential edge — **IMPORTED 2026-09-14 (PR #9), not verified here.**** memory-service mints its own
      service credential on all four outbound clients, and orchestration's
      `/internal/runs/:id/outcome-summary` accepts an explicit tenant from a service
      caller (alter-x-4- #144, #146, #147). Original scope: — from decision 0.1, now answered (design log §30). Additive
      tenant parameter on orchestration's `/internal/` routes; Memory stops discarding it.
      Plus: a tenant mismatch **refuses with a named reason** rather than degrading to "not
      found", and every service-asserted tenant is audited. *Unblocked.*
- [x] **2.2 replan and recompile — **IMPORTED 2026-09-14 (PR #9), not verified here.**** The task skeleton is persisted
      on the workflow version and replan runs from it, reviving the two dead strategies
      (alter-x-4- #145, #156). Original scope: — from decision 0.2, now answered. Send `TaskSkeleton`.
      Revives two of eight dead strategies. `repair` decides correctly then defers — finish
      it in the same pass; it is an omission, not a boundary.
- [x] **2.3 drift readback — **IMPORTED 2026-09-14 (PR #9), not verified here.**** `drift_read` admits the agent subject,
      with its own migration (alter-x-4- #142). Original scope: — small, real. `drift_read` admits only model and provider
      subjects, so agent drift scores compute, persist, and return zero rows to their own
      tenant. Add the agent subject.
- [x] **2.4a [+] the healing loop, everything provable locally. DEMONSTRATED 2026-09-15, PR #10.**
      One deliberately failed node driven through the real `RecoveryPolicyService` and real
      `RecoveryDispatchService`, with a real `PostgresRecoveryRunReader` against real Postgres:
      classified `logic_output_failure` from a persisted row, strategy chosen and its outcome
      written to `recovery_actions`, and **replan handed the planner the persisted task
      skeleton** — asserted positively against the stored skeleton and negatively against the
      compiled DAG's own `waves` and `edges`. The no-skeleton version declines rather than
      calling the planner. **Proven to fail:** reintroducing the pre-#145 behaviour fails both
      tests. Runs in CI by convention — the test target globs `src/**/*.spec.ts` and a
      Testcontainers spec in the same folder already runs there. Drift read-back as the owning
      tenant was verified separately by memory-service's own `test_drift_integration.py`
      (2 tests, 15.09s), which asserts the agent subject. Original scope: *Prompt ready
      [`prompts/revive-24a-healing-loop-local.md`](prompts/revive-24a-healing-loop-local.md)
      — needs Docker, does NOT need AWS.* Four of the six steps need no model provider: a
      real named failure reaching Recovery, classification and strategy selection, replan
      from the persisted task skeleton, and a drift score written and read back as the
      owning tenant. **Split out 2026-09-15** after a sandboxed builder hit the original
      prompt's gate: its Docker socket was denied and its AWS route was dead, and a partial
      live run nobody scoped in advance is how a phase gets closed on evidence that does not
      cover it.
- [x] **2.4b [+] BOTH STEPS DONE 2026-09-16.** **Step 5** driven live against Bedrock (PR #11),
      finding **C29**: the adapter wraps every response so `output_json` always parses and
      off-contract prose is accepted as a valid node result. **Step 6 demonstrated by existing
      coverage, run here today and composed for the first time:** memory-service's
      `test_real_performance_http_projection_computes_and_persists_drift` shows significant
      drift producing `action_taken == "weight_decay"` and the active routing policy's
      `similarity_weight` falling 0.8 to 0.0; intelligence-service's
      `test_active_routing_policy_changes_the_next_ranked_selection` shows an active routing
      policy changing which agent the ranked query returns (2 passed, 5.21s). **No new code was
      needed** — the chain was built and tested, and nobody had run both halves on one machine.
      **Caveat, and it is the gate's wording rather than the engine's behaviour:** the decay is
      tenant-wide and lowers `similarity_weight` only, so it shifts how candidates are weighed
      rather than penalising the drifted agent. Superseded note: **Step 5 closed** — driven
      live against Bedrock, and it found **C29**: the adapter wraps every response so
      `output_json` always parses and off-contract prose is accepted as a valid node result.
      **Step 6 is demonstrable after all** — C28 was withdrawn; the drift-to-policy-to-ranking
      chain exists. What remains is a live run proving it moves. Original, superseded: **Step 5
      done** — driven live against Bedrock, and it found **C29**: the adapter wraps every
      response so `output_json` always parses, `MODEL_OUTPUT_INVALID` is unreachable, and
      off-contract prose is accepted as a valid node result. **Step 6 blocked** — see below;
      nothing reads a drift score. Neither step is a test waiting to be written. Original
      finding on step 6: Step 6
      — a drift score changing the next selection — **cannot be demonstrated, because nothing
      reads a drift score.** Selection ranks on `performance_records` in intelligence-service's
      database; `drift_scores` lives in memory-service's and is read only by memory-service and
      the eval harness. `DriftAction`'s `weight_decay` is written onto the row and never acted
      on. Selection *does* read routing weights from Policy Store, so the only missing link is
      drift writing a policy — design log §17's inward path. **This is a build, not a test.**
      Step 5 (a genuine model-output failure classified as `logic_output_failure`) is still
      provable with Bedrock and remains in scope. Opens **C28**. Original scope: *Prompt ready
      [`prompts/revive-24b-healing-loop-real-provider.md`](prompts/revive-24b-healing-loop-real-provider.md)
      — needs Docker AND Bedrock in `ap-south-1`.* A genuine model-output failure classified
      as `logic_output_failure`, and **a drift score changing the next selection**. The
      second is the one most likely to be incomplete: selection now ranks on containment,
      similarity, performance and efficiency (PR #9), and whether a drift score reaches that
      ranking at all is an open question. Phase 2 does not close until this does.
- [x] **2.4 prove the cycle — SPLIT 2026-09-15 into 2.4a and 2.4b, both closed 2026-09-16.** Real
      failing nodes were run against Recovery on alter-x-4- and reclassified correctly
      (#150, #151, #166), but **nobody has watched the full circuit** — recovery, memory
      write-back, and a drift score that changes the next selection — and nobody has watched
      any of it in this repository. Original scope: — acceptance. Force a run to fail. Watch it reach Recovery,
      replan, summarise into Memory, and move a Drift score that changes the next selection.
      Anything less than the full circuit is not this phase finished.

**Done when** one deliberately failed run produces a recovery, a memory record and a drift
score readable by the tenant that owns it — demonstrated live, not in unit tests.

---

## Phase 3 — clear the known engine defects

*1–2 weeks · mostly parallelisable.* Listed after Phase 1 deliberately: two of these cannot
be judged fixed until a real provider exists, because the mock cannot tell a correct
binding from an incorrect one.

- [x] **3.1 capability filter — **IMPORTED 2026-09-14 (PR #9), not verified here.**** An agent must declare the capability
      it is bound for; containment decides eligibility (alter-x-4- #160, #162). The two score
      floors are removed on their measurement — see memoryalter 2026-09-14. Original scope: — needs Phase 1. Selection & Binding applies **no exact-
      capability filter at all**. Add it, then re-tune the similarity threshold against real
      embeddings.
- [x] **3.2 binding ranking — **IMPORTED 2026-09-14 (PR #9), not verified here.**** Measured latency and token cost move
      the ranking, with `efficiency_weight` read from the tenant's routing policy
      (alter-x-4- #161, #167). Original scope: — needs Phase 1. A 30–40× latency and cost swap does not move
      the winner; `agent_id ASC` decides it. The correctly-scoring `/bind-architecture`
      exists but has never run in the execution path — **treat as a migration with a
      fallback, not a swap.**
- [x] **3.0 [+] auto-creation idempotency. CLOSED 2026-09-08, SUPERSEDED 2026-09-14.**
      Replaced wholesale by alter-x-4-'s version, which carries the same idempotency design
      and also fixes the tier (task 3.3). Our migration `0006_agent_auto_creation_idempotency.py`
      is deleted; theirs, `0006_agent_auto_creation_key.py`, is the one that ships. Both
      declared revision `0006` and git merged them without a conflict — see memoryalter.
      Original record: Auto-creation is now
      idempotent per tenant + workspace + capability set. `agents` gains an
      `idempotency_key` (SHA-256 of the *sorted* capability set) and a partial unique
      index over `(tenant_id, workspace_id, idempotency_key) WHERE idempotency_key IS
      NOT NULL` (migration 0006, with a real downgrade). The engine pre-SELECTs by key
      and returns the stored agent without re-embedding; a genuine race is resolved by
      `INSERT ... ON CONFLICT DO NOTHING` — the loser's conflicting INSERT blocks on the
      unique index until the winner commits, then returns the winner's agent. Proven to
      fail first: three identical requests minted three agents (#125); now they collapse
      to one, two genuinely concurrent requests produce one usable binding, reordered
      capabilities hit the same key, and a different capability set still creates its own
      agent. Key scope is capabilities only — tier (hardcoded STANDARD today) is owned by
      3.3.
- [x] **3.3 auto-creation tier — **IMPORTED 2026-09-14 (PR #9), not verified here.**** Creation happens at the requested
      tier under a configured ceiling; above it the bind fails with
      `no_agent_at_required_tier` (alter-x-4- #157). **Ceiling default changed on import from
      `ADVANCED` to `STANDARD` per design log 31.** The trap this inherited from 3.0 is moot:
      their key is also capability-only, and creation only happens when no agent has the
      capability at all. Original scope: — from decision 0.3 (design log §31). Never create an agent
      that cannot satisfy the requirement that triggered it: above the configured ceiling,
      **fail the bind with a named reason**. Ceiling is config, default `STANDARD`.
      **Inherits a trap from 3.0:** the idempotency key hashes the capability set only, so
      once tier varies, a `PREMIUM` request for a capability set that already has a
      `STANDARD` agent hits the same key and **silently returns the STANDARD agent** — no
      error, a usable binding to the wrong tier. Decide explicitly whether tier belongs in
      the key, and migrate the partial unique index with it if so.
- [x] **3.4 capability resolver — **IMPORTED 2026-09-14 (PR #9), not verified here.**** The word naming the task decides
      the tier (alter-x-4- #153). Original scope: — independent. Advanced-tier terms are tested before
      fast-tier ones in a plain if/elif, so an incidental adjective decides the tier.
      Replace set membership with something that reads the request.
- [x] **3.5 tool gateway — **IMPORTED 2026-09-14 (PR #9), not verified here.**** The canonical tool set is pinned and what
      is missing is counted, so the denominator is a fact (alter-x-4- #154). Original scope: — independent. Define the protocol enum first; then the count of
      what is missing becomes a fact instead of an estimate.
- [x] **3.6 requirements map — CLOSED 2026-09-14 BY DELETION, not by filling.**
      alter-x-4- #152 drops the write-only columns. Design log 32 named deletion as one of its
      two clean resolutions, so this closes C14 as well. Original scope: — from decision 0.4. Do it here, while the architecture path
      is still fresh in someone's head.

**Done when** an unrelated capability request fails to bind instead of matching; the
cheaper of two equivalent agents wins on cost; and a repeated unmet requirement stops
creating agents.

---

## Phase 4 — rebuild the two brains

**PHASE 4 CLOSED 2026-09-28.** 4.1 reproduced here at 35/36; 4.2 at 24/24 twice; 4.3 golden sets written before the rewrites.

*3–5 weeks · the real product risk.* L6 is the strongest layer in the system and is being
handed decisions made by string matching. These are rewrites, not repairs — and safe to
schedule late, because what L6 consumes is a plan, not the Planner.

- [x] **4.1 planner rewrite — CLOSED 2026-09-28: reproduced here at 35/36 (0.972), zero fallbacks, three live runs.** Measured by `apps/eval-service/tests/test_planner_strategy_live.py` (eval PlannerClient → intelligence-service → model-gateway on real AppConfig → Bedrock `apac.amazon.nova-lite-v1:0`), which fails on any keyword fallback as well as below 0.90; with the gateway stopped it reads 17/36, 28 fallbacks, and fails. The one miss is the same v1 case theirs missed. **Previously recorded:** IMPORTED (PR #16), NOT REPRODUCED HERE. Their model-backed
      selection with keyword fallback scores 35/36 on their machine. Here: **27/36 on Qwen** (our
      task 1.5 binding) and **17/36 on Nova Lite with all 28 calls falling back** — exactly the
      pre-rewrite keyword score. **Every Nova model in `ap-south-1` is `INFERENCE_PROFILE` only and
      cannot be invoked by a bare model id**, which this repository recorded on 2026-09-09 and
      nobody connected. **Blocked on C31, not on code.** Original scope: A padded trivial lookup escalates to manager-worker while a
      real three-team, twelve-country migration in 28 words does not — **the classification
      is inverted relative to actual scope.** Replace with a model call behind the same
      contract, keeping the keyword path as a fallback for provider outages.
- [x] **4.2 synthesizer rewrite.** **CLOSED 2026-09-27 — proven here at 24/24 twice (2026-09-22).** Returns byte-identical topology, waves, roles and a
      hardcoded `confidence 1.0` whatever the constraints. Make constraints actually shape
      the architecture, and make confidence mean something. **Design log §1 names this the
      product's entire differentiator, and one of only two genuinely unproven pieces.**
- [x] **4.3 golden sets** **CLOSED 2026-09-27 — both sets were written before the rewrites.** — how you know. Write the planner and architecture golden sets
      **before** the rewrite, so the target is fixed in advance rather than fitted
      afterwards.

**Done when** the planner golden set passes its floor of 0.90 and the architecture one
demonstrably changes topology when constraints change — both measured by the harness,
against a real provider.

---

## Phase 5 — build what does not exist

**PHASE 5 CLOSED 2026-09-28.** 5.1 voice cut and removed; 5.2 repository manager built standalone; 5.3 deployment manager imported (their #218/#219).

*4–8 weeks · scope depends on decisions.* Both need a product decision before an
engineering one. See 0.6.

- [x] **5.1 voice** **CLOSED 2026-09-27 — executed by their #183; the tree is clean.** — **decision made 2026-09-08: CUT** (design log §33). *Decided, not
      executed.* The declaration still exists, so the six RPCs still generate clients and
      still appear in every count. Remove or deprecate them — a note is not a cut. Six RPCs declared (`BindNumber`, `GetNumberBinding`,
      `ConfigureCallHandling`, `InitiateCall`, `GetAccountHealth`, `GetCapabilities`), no
      implementation under `apps/`. Needs a telephony vendor, a number-provisioning story,
      and a decision about whether voice ships at all. **The design log never mentions voice
      once** — not deferred like Project Mode, simply absent.
- [x] **5.2 repository manager** — **BUILT 2026-09-28, standalone (design log §33 amended by Havish):** `apps/platform-api/src/repositories` (bindings table 0021 with tenant RLS, GitHub read client acting as the workspace's own OAuth connection, routes to list/link/unlink and read branches and open pull requests) and the Repositories settings page. Read-only against GitHub; no token stored. Live proof against GitHub waits on registering a GitHub OAuth app (handoff). **Previously:** decision made 2026-09-08: CUT (design log §33).
      *Decided, not executed.* Remove or deprecate the declaration. C9. No backend contract to build
      against.
- [x] **5.3 deployment manager** **CLOSED 2026-09-27 — their #218/#219, imported in PR #18: version lifecycle and real rollback.** — surface only. C8. The backend contract is real
      (`DeployctlService`, three RPCs); only the surface is missing. Cheapest of the three —
      do it first within this phase.

**Done when** each of the three either ships, or is explicitly cut and its contract marked
as such, so it stops appearing in counts as pending work.

---

## Phase 6 — production hardening

*2–4 weeks · runs alongside Phases 4 and 5.* Everything verified so far ran against a
single-host stack with LocalStack standing in for AWS. **The local-versus-real gap is where
the remaining surprises live.**

- [ ] **6.1 real AWS** — **decision needed first: their #232 targets one EC2 instance with Docker and Bedrock for the MVP; their #231 keeps Aurora with IAM as the default. Images (#223), ECR (#224), mesh ports (#229) and image CI (#230) are imported.** — the big one. Secrets Manager, SSM, S3, SQS and EventBridge all
      resolve against LocalStack today. Real IAM, cross-account boundaries and regional
      endpoints are where this bites — particularly IAM database authentication, which every
      service declares and none has exercised. *Prove this pattern on one service early,
      not late.*
- [ ] **6.2 temporal** — **code half imported 2026-09-27 (their #222, PR #18): separate queues, continue-as-new, pinned worker versions, retention floor, runbook. Left: a real cluster or Cloud namespace, and running against it.** — durable substrate. Local Temporal is `start-dev`, one process, no
      persistence guarantees. Moving to Cloud or a real cluster changes retention, history
      size limits and worker versioning — all of which the executor workflow assumes are
      generous.
- [x] **6.3 approval route** **CLOSED 2026-09-27 — proven by their #188 and re-proven here at 3/3.** — never verified. The engine's pause and resume work, driven
      by a signal. The REST route a person actually uses to send it has never been
      exercised; it needs a properly minted delegation token.
- [x] **6.4 chain verification** **CLOSED 2026-09-27 — their #221, imported in PR #18: weekly full verification job and route.** — audit. Incremental verify resumes from a checkpoint, so a
      forgery in checkpointed history is never re-examined. `verifyChain()` exists with **no
      route and no caller**. Schedule it, even weekly.
- [ ] **6.5 load and failure evidence.** The eval harness already carries chaos scenarios,
      load suites and release gates with nine metric floors and eight required checks. They
      have never been run against anything real. Run them.

**Done when** the promotion gate returns approved on genuine evidence — nine metrics above
their floors, eight checks passing, three approvals recorded — rather than on a
hand-written bundle.

---

## Track B — the platform, in parallel

*3–5 weeks · fully parallel · highest value per hour.* Deliberately unnumbered by the plan,
because nothing here waits on anything above.

**Solo caveat:** the plan assumes different people run this simultaneously. With one
person, Track B competes with the engine rather than running beside it. Take **B5** and
**B4** early anyway — one lies, the others are additive and safe — and defer the rest until
the demo runs.

- [x] **B6 [+] a trigger can never be removed.** **CLOSED 2026-09-25 — removal archives through the status route (their #198); decided disable-only by design, integration-tested here in PR #17.** B5 made the control refuse honestly, which is
      correct and leaves a real product gap: `platform-api`'s trigger controller has no `DELETE`
      at all, so nothing can remove a trigger by any route. Surfaced by PR #12's honest refusal
      rather than fixed by it. Decide whether removal is disable-only by design, or whether the
      route is simply missing.
- [ ] **B1 admin console** — 14 screens, 8 modules. Largest single block of
      finished-but-unreachable work. The plan says start here; solo, it does not.
- [ ] **B2 commerce** — Marketplace (8 methods), Publisher & Payout (fully mock), Cost &
      Billing (10 methods). Billing runs on Razorpay; the webhook path already exists.
- [ ] **B3 the rest** — Notifications (7), Benchmarking (7), Discovery (2), Search. **Search
      returns invented results** — the one actively misleading item. Tool Registry and Media
      Services were source-read only; confirm live before counting them.
- [x] **B4 four missing routes — CLOSED 2026-09-16, PR #12.** Run cancel, run retry-node,
      `GET /projects`, `GET /projects/:id`, with workspace and tenant scoping. Original scope: — additive, safe. Run cancel, run retry-node,
      `GET /projects`, `GET /projects/:id`. Nothing depends on them. Good first tickets.
- [x] **B5 trigger management — CLOSED 2026-09-16, PR #12.** `testTrigger` now throws when the
      response carries no event id instead of manufacturing success; `removeTrigger` **refuses
      honestly** — "no delete route exists. Disable the trigger instead." Verified independently:
      the trigger controller has create, list, get, versions, enable, test and rotate, and **no
      delete**, so the refusal is true and points at a route that exists. Artefact asserts on the
      **call** (`toHaveBeenCalledExactlyOnceWith` on url, method, body, credentials), not the
      rendered result, which is what catches a control reporting success with nothing behind it.
      Opens **B6**. Original scope: — silently lying. `testTrigger` and `removeTrigger` report
      success without calling anything. **Prioritise above cosmetic items:** a control that
      claims to have deleted something and has not is worse than one that does nothing
      visible.
- [x] **B-vocab — CLOSED 2026-09-16, PR #12.** Platform moved to
      `pending·approved·rejected·expired`; `open` is now rejected at both the client and the query
      parser with "Unsupported approval status". **Engine enum untouched**, per decision 0.5.
      Original scope: — from decision 0.5, now answered. Human Action Centre adopts the engine's
      enum (`pending·approved·rejected·expired`).

**Done when** every screen issues real requests, and no control reports success without a
call behind it.

---

## Track C [+] — design-log compatibility

**Not in the action plan. Ours.** The action plan restores the engine; this track holds it
to the design log's standards. Priced individually, never batched. Nothing here blocks the
demo.

- [x] **C1 architecture gates. DONE 2026-09-28** — `scripts/gates/`, CI step "architecture gates",
      baseline of 722 findings (mock-reachability 25, unsafe-default 219, driver-existence 59,
      duplicate-primitive 146, safety-duplicate 34, cost-no-float 61, deletion-registration 174,
      capability-coverage 1, verifier-driver 2, deletion-schema 1, test-env-file 0). Fails on a new
      finding and on a stale baseline entry. Original: Export the 11 AST gates from `alterengine--5`, each with a
      baseline allowlist of every current violation, so they fail only on **new** ones.
      Nobody stops for a cleanup sprint; every later fix lands governed.
- [x] **C2 `RUNTIME_MODE` switch — CLOSED 2026-09-16, PR #13 (`3c03199`).** Carries C15.
      `createEnvironmentValidators().runtimeMode()` (`packages/adapters/src/config/environment-validation.ts`)
      is now shared across every service: defaults to `mock`, and throws
      `RUNTIME_MODE: mock is not allowed when NODE_ENV is production` — the fatal-boot-error
      §7 pattern 2 calls for, verified live in CI. `configSource()` in the same file now
      answers only *where real configuration lives* (`appconfig`/`local-file`), rejecting
      `mock` outright — the scoped overrides (`AUDIT_CONFIG_SOURCE`, `MODEL_GATEWAY_CONFIG_SOURCE`)
      collapse into the one shared switch as designed. **Blast radius wider than the
      builder's own report:** three pre-existing test fixtures across three services
      (orchestration-service, eval-service, platform-api) simulated production without ever
      declaring `RUNTIME_MODE`, so the new fatal guard fired before the check each test
      actually meant to exercise. Found because CI was watched to completion twice more
      after the builder's report claimed green — not caught by their own 117 focused tests.
      Fixed directly (`0c9d593`, `4dd53ac`) after a full repo-wide sweep for the same
      pattern, verified against each fix individually rather than by inference. Original
      scope: (§7 pattern 2). In production, any mock selection is a
      fatal boot error, never a silent fallback. Do alongside Phase 1.
- [x] **C3 deletion registration in CI** (§18, §28). **DONE 2026-09-28**: registry of all 125 tables in 8
      databases, certified in CI against schemas built from real migrations; 62 erasure gaps made visible
      and held by `MAX_ERASURE_GAPS` (closing them is C3b). Original: Do before more components store tenant
      data. The old build's erasure certified complete while data survived in ten tables it
      never touched.
- [ ] **C4 safety as a shared in-process library** (§11). Largest item. Unblocks the eval
      harness, which scored 0/30 on one unreachable service.
- [ ] **C5 cost ledger records verification verdicts** (§21). Missing this early means
      backfilling data never captured.
- [x] **C6 cost ledger consistency — CLOSED 2026-09-16, PR #13 (`3c03199`).**
      `EstimationService.estimate()` (`apps/cost-ledger-service/src/estimation/estimation.service.ts`)
      now requires a `ten_`-prefixed tenant ID and converts to bare UUID internally
      (implements C19's decision — prefixed outside, bare inside), and rejects any
      `lineItems[].source` not in the `COST_SOURCES` union before estimating anything —
      `source: "telepathy"` now throws `EstimationValidationError`, verified by
      `estimation.service.spec.ts` and `estimation.controller.spec.ts`.
- [ ] **C7 Agent Factory extracted** as its own L4 component (§22 item 9) — two callers in
      different layers.
- [ ] **C8 Side-Effect Ledger + idempotency gate** in front of Dispatch (§4, §22 item 7).
- [ ] **C9 reviewer isolation** against prompt injection (§5.4).
- [ ] **C10 Run Manager atomic budget gate** (§22) — must be atomic, not read-then-decide.
- [ ] **C11 Policy Store global tier**, structurally incapable of holding tenant content
      (§22).
- [ ] **C13 map the 54 contracts onto the 61 components** — from decision 0.7. Replace the
      proposed blast radius / fail mode / driver values in `components/` with
      `architecture/component-contracts.md`'s. Its done gates are targets, not gates that
      fail today. Roughly a day; closes design log §29's open item.
- [x] **C16 one source for ports, and a health check worth trusting. CLOSED 2026-09-09.**
      Fourteen ports parameterised, defaults unchanged, connection URLs deriving from the same
      variables so they cannot disagree. Nine cached-status reads replaced by fresh probes.
      Drift check wired into CI. **Coexistence proved live** — ten containers on offset ports
      beside two untouched sibling stacks, with a row written and read back on the overridden
      port only. Surfaced **C23** and **C24**. Original scope: *Prompt ready
      [`prompts/revive-C16-ports-and-health-check.md`](prompts/revive-C16-ports-and-health-check.md).*
      **Port parameterisation folded in:** `docker-compose.yml` hardcodes fourteen host ports,
      so two checkouts cannot coexist — which is both why the check cannot be trusted and why
      the 1.5 measurement could not start. Three tasks have now paid for it. Original scope: **It
      failed its first real use:** task 1.3 ran on alternate ports and the script, which
      hardcodes committed ports, could not serve — the services were verified by hand
      instead. The port-sourcing fix is not cosmetic. Task 1.0
      produced it and it is committed, but it does **not yet meet
      [`verification-standard.md`](verification-standard.md)** and is deliberately unwired
      until it does. Two gaps, both acknowledged in the script's own header: **nine of
      twenty-six checks read Docker's cached `Health.Status`** rather than probing (a
      container that just died reads healthy for up to one 5s interval — that is process
      state, not real behaviour); and **some port defaults are sandbox values, not committed
      ones**, so on a machine using committed ports those checks fail for the wrong reason.
      Fix both, then join the four `scripts/check-*.sh` gates in CI's `gate` job.
- [x] **C21 make starting the stack a step, not research. CLOSED 2026-09-09.** Bootstrap
      committed with create/merge/check modes, `--check` wired into CI's gate job — the first
      verification artefact in this project to acquire a driver. Both undefined placeholders
      resolved against the running stack, not guessed: `ADS_DB_PASSWORD=ads_core_local` from
      `docker-compose.yml`, `MEMORY_DB_PASSWORD` defaulting to `AUDIT_DB_PASSWORD` in
      `engine-db-init.sh`. **Left a gap — see C22.** Original scope: *Prompt ready
      [`prompts/revive-C21-env-bootstrap.md`](prompts/revive-C21-env-bootstrap.md).* **Two
      placeholders are referenced but never defined** — `ADS_DB_PASSWORD` and
      `MEMORY_DB_PASSWORD` — so the example is incomplete, not merely unsourceable, and
      nobody can fill it correctly without deciding what they are. `.env.local.example` cannot be
      sourced: 25 lines carry `<placeholder>` values, including five database passwords that
      nineteen connection strings interpolate, plus a hex token and its SHA-256. Nothing
      generates it, and `local-dev.md` never says how. The working `.env.local` in use has 16
      assignments against the example's 139, so the documented `cp` produces something
      different from what anyone runs. **This blocks task 1.5's live measurement**, and it is
      the mechanism the assessment blamed for two wrong counts, still present after task 1.0.
      Needs a bootstrap script that generates and propagates the values, committed.
- [x] **1.5b [+] make the golden-set runner actually run. CLOSED 2026-09-09.** PR #7 merged
      (`2e2c498`, seven originally-named defects). PR #8 merged (`50edf30`, C26's Nx-bypass
      fix plus the `pnpm install` gap). Done gate met for real: a genuine fresh clone, no
      hand-editing, real Docker, real AWS, produced Phase 1's first real golden-set number —
      21/30 passed, 0.70. See 1.5 above for the number and what it means.
- [x] **C23 the health check must verify identity, not just status — CLOSED 2026-09-16, PR
      #13 (`3c03199`).** `scripts/check-stack-health-script.sh` now refuses to accept a probe
      with no service-identity expectation (`check-stack-health-script: $service probe has no
      service-identity expectation`), and compares the response body's `service` field against
      the one expected — a 200 from the wrong service now fails the check instead of passing
      it. Real regression test: two service processes deliberately bound to swapped ports (8001
      and 18001), both answering `{"service":"verification-service"}`, both correctly caught.
- [x] **C24 application service ports need what C16 gave dependency ports — CLOSED 2026-09-16,
      PR #13 (`3c03199`).** `scripts/verify-coexistence.sh` now exports every application
      service's port as an override too, not just the fourteen dependency ports C16 covered —
      the health check probes the actual overridden ports on a multi-checkout host instead of
      literal defaults that belong to a sibling stack. **Not independently live-verified here**
      — the builder's report is explicit that a full multi-checkout fleet run wasn't performed;
      the script change itself was read and is real.
- [x] **C27 [+] NOT A DEFECT — it was the clone location. CLOSED 2026-09-15.** The same spec
      runs in 141ms from `~/alter-work/`, and never terminates from a scratch path under
      `/private/tmp` with a second clone beside it. `CLAUDE.md` already names `~/alter-work/`
      as the convention. **What survives as a real but minor gap:** `orchestration-service`,
      `intelligence-service`, `model-gateway`, `tool-gateway`, `sandbox-service` and
      `provisioning-service` have no `vitest.config.ts` while seven other projects do. Worth
      adding for consistency; it causes nothing. Original, incorrect diagnosis: `vitest run` against
      `orchestration-service` specs returns **zero output** and holds a core at 98-100% CPU
      until killed — three times, including on two pure unit specs. `orchestration-service`,
      `intelligence-service`, `model-gateway`, `tool-gateway`, `sandbox-service` and
      `provisioning-service` have **no `vitest.config.ts`**, while seven other projects do, so
      their specs run under root defaults with nothing bounding discovery. CI passes in ~10
      minutes, so this is invisible from outside. **It blocks every task whose artefact is a
      test, and it blocked 2.4a.** Pairs naturally with C25 — both are "the tooling config
      nobody looked at".
- [ ] **C29 [+] nothing validates model output against the task's contract. Slice 2b BUILT 2026-09-28: criteria reach the producing node and the gate, which fails any unmet criterion (see memoryalter); live Bedrock proof outstanding. SCOPED 2026-09-16,
      and it is the same work as C12.** The contract is not missing from the system, it is
      missing from the *path*: `success_criteria` is decided at the top of the design path and
      never reaches the node that produces output or the gate that judges it. **Fix is to carry
      them down, not to add a per-node `output_schema`** — that would put a second judge of node
      output beside the frozen Verification & Quality Gate (§7 pattern 4). **Slice 2a MERGED 2026-09-16 (PR #15)** — the Planner assigns each intake criterion to named nodes, and validation is two-way: an intake criterion assigned to no node fails, **and a criterion appearing on a node that was never in the intake list fails too** (the planner paraphrasing one is silently a different criterion). **Slice 1 MERGED 2026-09-16 (PR #14)** — criteria carry from ProblemSpec to the stored version, legacy workflows unaffected. **Slice 2 scope grew:** the Planner must assign criteria per node during decomposition (see memoryalter 2026-09-16); a criterion matching no node fails loudly. **Freeze exemption GRANTED 2026-09-16** for Graph Compiler, the
      Executor and the Verification & Quality Gate, C29 only (see memoryalter). Prompt issued. Original finding: The Bedrock
      adapter wraps every response as `{message, stop_reason}` and the gateway passes it
      through as `output_json`, so `output_json` always parses and `MODEL_OUTPUT_INVALID` is
      unreachable on the real-provider path. **Prose, or an answer to a different question
      entirely, is accepted as a valid node result** and falls through to `ask_user`. The
      classifier and strategy table are correct — the producer of the code is what is missing.
      Also unresolved: #151's live evidence shows some path where `output_json` is raw text,
      and which provider that is has not been established. Found by task 2.4b step 5, live
      against Bedrock; pinned by
      `apps/orchestration-service/src/recovery/model-output-failure.live.spec.ts`.
- [x] **C28 [+] WITHDRAWN 2026-09-16 — the path exists.** `DriftDetector` calls
      `apply_drift_decay`, which decays the tenant's `routing_weights` policy and promotes the
      replacement; selection reads those weights on every bind. My original finding grepped for
      readers of the `drift_scores` table and missed the call path entirely. **What survives as
      a real question:** the decay is tenant-wide and lowers `similarity_weight` only, so it
      shifts how candidates are weighed rather than penalising the drifted agent. Whether the
      gate's "changes the next selection" means that, or means per-agent penalisation, is worth
      settling deliberately. Original, incorrect finding: Drift scores compute,
      persist, and are readable by their tenant — and nothing consumes them. `DriftAction`
      records `weight_decay` as an intent no code performs. Selection reads routing weights from
      Policy Store, so the shortest honest fix is for a drift verdict to propose a policy rather
      than for selection to read drift directly — which would also give the engine one place
      where "what we learned" turns into "what we do". **Phase 2's done gate depends on this.**
- [x] **C25 no root `eslint.config` file exists — ANSWERED 2026-09-16, no gap.** Checked, not
      just surfaced this time: `lint` is real for every one of 21 project targets, each backed
      by its own per-app ESLint, Ruff, or Oxlint config. No root config added, because none is
      missing — the original finding assumed a single shared root config is the only valid
      shape and never checked whether per-project configs already covered it.
- [x] **C26 Nx graph computation on a cold, fresh clone is unusably slow, blocking 1.5/1.5b.
      CLOSED 2026-09-09** (PR #8, `50edf30`). `pnpm exec nx run eval-service:build` ran
      95–99% CPU for 14+ minutes on a genuine fresh clone and was killed, never returning —
      confirmed independent of sandboxing, independent of the Python virtualenv, independent
      of git performance. Nx's own project-graph computation is separately fast (its daemon
      log: `createProjectGraph()` in 20.9ms) — the slowness is specific to this invocation's
      task orchestration/hashing, isolated but **not fully root-caused** (V8 sampling showed
      time inside string/hash-table primitives, consistent with hashing a large in-memory
      structure). **Fixed by not depending on the answer:** `scripts/run-intent-golden-set.sh`
      no longer routes through `pnpm exec nx run <target>` for its build steps — it runs the
      same underlying commands each `project.json` target already defines, directly, in the
      real dependency order. Proven: the full sequence, direct, took 12.4s; confirmed
      identical dist output files. Companion gap fixed in the same PR: a genuinely fresh
      clone has no `node_modules`, and neither the runner nor `docs/local-dev.md`'s
      Prerequisites said to run `pnpm install` first — both now do.
- [x] **C22 the bootstrap breaks real AWS — CLOSED 2026-09-16, PR #13 (`3c03199`).**
      `scripts/bootstrap-env-local.sh` no longer generates the LocalStack `test`/`test`
      credentials at all — removed outright, not merely guarded — and `verify_file()` now
      rejects them explicitly (`LocalStack test AWS credentials override the operator's
      ~/.aws profile; remove AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY from $f`) if they
      appear by any path. Verified by the builder's own added regression: the guard rejects
      the LocalStack credentials, and a clean environment passes. **Second instance of the
      pattern `AWS_ENDPOINT_URL`
      showed in 1.2**: a LocalStack variable silently defeating the real-AWS path, failing in
      a way that points at the wrong thing. 1.2's instance got a fatal guard; this one has none.
- [x] **C20 fallback chain — DECIDED 2026-09-15, and the fix is smaller than recorded.**
      `FallbackBindingSchema` already carries `{provider, model_id}`
      (`packages/contracts/src/model-alias-policy.ts:11-18`). Add `bedrock` to
      `FallbackProviderSchema`, and give the primary an explicit provider defaulting to
      `bedrock`. Implementation still to do. Original scope:
      `FallbackProviderSchema` is `z.enum(["anthropic", "openai"])`, so a fallback may only
      name Anthropic or OpenAI. Anthropic is out of scope by decision, and OpenAI-on-Bedrock
      returned no text when tested. The primary `model_id` is a free string and takes any
      Bedrock model, so **only the fallback is constrained** — and it is currently
      unusable. The question is not whether to add a member: it is whether a *provider* enum
      is the right shape when the primary is addressed by model id. Decide the shape, not the
      contents.
- [x] **C19 tenant-id format — DECIDED 2026-09-15: prefixed outside, bare inside.** `ten_`
      at every external surface including AWS resource names; bare UUID inside the database,
      which is what the columns already are. Only the bare-UUID secrets need recreating.
      Implementation still to do. Original scope: Tavily integration secrets
      exist under four shapes for what looks like one tenant: a bare UUID, two `ten_`-prefixed
      variants, and `ten_test0000…`. Same drift as the Cost Ledger tenancy split, except
      fixing it here means recreating tenant secrets rather than editing a query. Decide the
      canonical shape before more tenant secrets are created.
- [ ] **C18 backfill: re-embed stored vectors when the provider changes.** *Detection and
      containment folded into task 1.3* — provenance recorded from `EmbedResponse.model_id`,
      stale vectors excluded from candidacy, exclusions counted. **What remains here is the
      repair:** a batch job that re-embeds existing rows, needing credentials at run time.
      Until it exists, an agent whose vectors are stale is visible and harmless, but still
      unfindable. Original finding: Stored
      vectors live in their producer's embedding space. Every existing `capability_embeddings`
      row is mock-space; the moment Titan is live for a tenant with existing agents, those
      vectors are meaningless and matching degrades to noise **silently** — no error, no
      failed insert. Nothing records which provider produced a vector, so mock-space and
      Titan-space rows are currently indistinguishable. Needs a provenance column and a
      re-embed path before any tenant with real data switches. **Found by task 1.2's
      counterfactual needing two vector rows for one capability.**
- [x] **C17 what the semantic cache is for — DECIDED 2026-09-15.** Exact-match only until
      the plane is deliberately designed (design log §12), and the eval harness bypasses it
      unconditionally. Keeps the measured 15.5× speedup on identical text; removes a semantic
      behaviour change nobody approved. Implementation still to do. Original scope: `model-gateway` consults a semantic
      cache before every model call, threshold 0.95, on both invoke and stream paths. Under
      mock embeddings everything clusters at 0.85–0.87 so it only hits on identical text;
      **real embeddings will push near-identical prompts past 0.95 and make it genuinely
      semantic — a behaviour change task 1.2 causes as a side effect that nobody decided.**
      Design log §12 defers this plane past v1, yet it is built and live. Also decide whether
      eval golden sets bypass it, or the harness measures the cache rather than the model.
- [x] **C15 one variable, one question — DECIDED 2026-09-15, implemented as part of C2.**
      The split is the answer: `RUNTIME_MODE` takes *real or mock*, `ALTER_CONFIG_SOURCE` keeps
      *appconfig or local-file* for everyone. Not closed by code yet — closed as a decision.
      Original scope: Engine services ask
      "mock or appconfig?"; platform-api asks "file or appconfig?". Two different questions
      wearing one name, currently resolved by per-service scoped overrides
      (`AUDIT_CONFIG_SOURCE`, and `PLATFORM_API_CONFIG_SOURCE` added in 1.2). Two instances
      means it is the rule, not the exception. Decide whether scoped overrides become the
      documented pattern for every service, or the values are unified. **Found by task 1.0
      running the stack, not by reading it.**
- [x] **C14 node_requirements single source of truth. CLOSED 2026-09-14** by task 3.6's
      deletion of the columns. Original scope: — from decision 0.4's recorded
      residual. A stored map plus fresh run-time resolution is §7 pattern 4. Either run-time
      consumers read the column, or it is deleted. Touches the frozen Executor, so **after
      revival**, not during.
- [x] **C12 ANSWERED 2026-09-16 — §5.1 is half-built, §5.2 is absent.** `success_criteria` is
      produced and validated on `ProblemSpec` and **read by nothing**; every other occurrence in
      the repository is a test. §5.2's mechanical read-back has no trace. Half-built is worse
      than absent here: the field makes the capability look present in a source read. **It is a
      subsystem, as this item predicted**, and it is the same work as C29. Original scope: — structured success criteria and mechanical
      read-back. **Absence is currently inferred, not established.** Check before scheduling;
      if genuinely missing this is a subsystem, not a patch.

---

- [ ] **C30 [+] design log §16's four approval modes do not exist.** Not always-block, not
      auto-approve, not skip-on-timeout, not approve-once-then-promote. The imported code places a
      gate before qualifying external side effects — placement without modes. Found during the
      #172–#193 import. Decide whether §16 gets built or amended; Track D owns the second option.
- [x] **C31 [+] bind the model aliases to invocable ids, then re-measure 4.1.** **CLOSED 2026-09-28 AS A MISDIAGNOSIS.** The deployed aliases already name inference profiles (`apac.amazon.nova-lite-v1:0` etc.), and 4.1 clears the floor on them. The 17/36 of 2026-09-22 was the path never reaching a model: #173's own table shows 17/36 with 28 fallbacks when the issuer is down, and `run-model-gateway-aws.sh` was starting the gateway in mock mode (found in 1.6). The keeper stays true: a fallback hid an outage as a score. Every Nova model in
      `ap-south-1` needs an inference profile ARN; a bare id fails every call and the keyword
      fallback hides it. Bind `STANDARD` to a working profile, re-run the planner golden set, close
      4.1 only if it clears 0.90 here. **The finding worth keeping: a fallback masking a total
      provider failure reads as a mediocre score, not as an outage.**

- [ ] **C32 [+] container images cannot be published from this repository.** Found 2026-09-27 on the
      first push after PR #18: the imported `images` workflow builds all images, then every push to
      `ghcr.io/havishalterx-eng/alter-*` fails with `denied: permission_denied: write_package`. The same
      workflow publishes those names successfully from `alter-x-4-`, so the packages are almost
      certainly linked to that repository (not confirmed: the token here cannot read packages). Two
      repositories now publish the same image names. **Havish's decision:** grant this repository write
      access to each package, rename ours, or disable the workflow here until building consolidates.
      Until then `images` is red on every push to `main`; `ci` is unaffected.
- [x] **C33 [+] a timing-sensitive Temporal test flakes on CI.** Fixed 2026-09-28 (#31): waits on the first run's result with `followRuns: false`, which settles exactly at continue-as-new; with no rollover the test now fails instead of passing late. `conversation-lifecycle-workflow.spec.ts`
      "continues as new before history grows" failed once on PR #18 with `pollUntil timed out after
      10000ms`, passed on rerun and 5/5 locally; their CI has passed it every time. Code identical to
      theirs. Make the wait deterministic rather than longer.
- [ ] **C34 [+] most specs authorize through the non-enforcing `RbacModule`.** Workspace isolation on
      project and workflow routes lives in `EnforcingRbacModule`; only the revive-platform integration
      suite binds it (PR #17). A regression in the resolver would pass every other test.

- [ ] **C35 [+] vitest hangs whenever the repository-root `.env.local` exists.** Found 2026-09-28:
      any vitest run (platform-api, model-gateway) sits at 100% CPU with no output after Vite loads
      env files; moving `.env.local` aside makes the same spec pass in seconds. Every developer who
      follows AGENTS.md has that file. Likely Vite's env expansion on the file's many
      `${VAR:-default}` values; not yet proven. Workaround: set `envDir` for test configs, or run
      tests with `.env.local` moved.

- [ ] **C36 [+] §5.2 mechanical read-back.** Verification never confirms an action actually took
      effect by reading it back. Named in C12 (2026-09-16) as absent; had no board item until now.
- [ ] **C37 [+] §5.3 end-of-run holistic check.** No judgement over a whole run's result. No match
      in code by name (2026-09-27); had no board item until now.
- [ ] **C38 [+] §19 Capability Registry holds reusable workflow templates.** Required from day one;
      no match in code by name (2026-09-27); had no board item until now.
- [ ] **C39 [+] §17 Drift Detector outbound suggestion path to the user.** Drift is computed and
      persisted but never surfaced; had no board item until now.

---

## Track D [+] — design-log conformance, after the builds

**Decided 2026-09-16 by Havish.** Runs once Phase 4, Track B and Track C are finished.
Reasoning in [`memoryalter.md` §2](memoryalter.md#2-decisions).

- [ ] **D1 the whole log against the whole system.** All 33 design-log sections against all 61
      components, plus the four architecture documents made binding by decision 0.7. Not a spot
      check of whatever someone is editing — that is what Track C already does, and Track C
      cannot find divergences in components nobody is touching.
- [ ] **D2 record before fixing.** Every divergence written down before it is resolved, so "the
      log says X and the code does Y" is never settled by quietly editing the log.
- [ ] **D3 the log may be the thing that is wrong.** The pass must be able to conclude *amend
      the log* as readily as *change the code*. §4's five classify buckets against the code's ten
      failure classes is the known candidate, and §4 itself flagged that taxonomy for refinement.

**Why after, not now.** Phase 4 rewrites the Planner and the Synthesizer, two of the components
most likely to diverge, so a pass that precedes it measures a system about to change.

**Already banked, found by reading §4 against the code on 2026-09-16** — a preview of what this
track is for: no idempotency gate in front of Dispatch (C8), no post-hoc user notification of
what self-heal did, and `safety_violation` handled inside Recovery when §4 says safety halts the
workflow before Recovery is invoked.

---

## Open now — the short list, 2026-09-27

Everything below is also a numbered item elsewhere in this file. Updated after PR #18 imported
`alter-x-4-` #216–#232, which leaves nothing of theirs unimported as of `4e73a08`.

**Blocking the demo**
- [x] **C31 / 4.1** — closed 2026-09-28: 35/36 here, zero fallbacks; C31 was a misdiagnosis.
- [ ] **C29 slice 2b** — carry success criteria to the producing node and the gate.
- [ ] **C30 — §16's four approval modes do not exist in code.** Build §16, or amend it in Track D.

**Decisions waiting on Havish**
- [ ] **6.1** — EC2 + Docker + Bedrock MVP (their #232) or AWS-native first.
- [x] **5.2** — built standalone 2026-09-28; live GitHub proof needs the GitHub OAuth app registered.
- [ ] **C32** — image publishing collides with `alter-x-4-`'s packages.
- [ ] **Tell Surya and Satwik that building moves to alterengine-6.** Every week it waits adds an import.

**Still true and easy to forget**
- [ ] **C8** — the idempotency gate §4 makes mandatory; the side-effect label it needs is in.
- [ ] **Track D** must judge the rules adopted from `alter-x-4-` (#185–#187, #211, #215, #232), not inherit them.

---

## Standing rules

1. **Do not touch the 25 Category 1 components.** No logic change, no code change. Anything
   necessary gets recorded in `memoryalter.md` before it is made.
2. **Never let "not assessed" collapse into "works."** Keep the fifth column.
3. **A builder report is not evidence.** Verified independently, by running it.
4. **Every task leaves behind something that keeps its result true.**
   [`verification-standard.md`](verification-standard.md) is binding: real behaviour not
   process state, runs without anyone remembering, **proven to fail**, nothing permanently
   red. "Nothing to check here" must be argued in the report, never assumed by silence.
5. **Never delete branches. Never force-push.**
6. **Never write to `alter-x-4-`.** Frozen, reference-only. Every artefact belongs here.
7. **Every master prompt states the working location, and it is never the CEO session's
   clone.** Two sessions in one working directory has now cost an unpushed commit and a
   bring-up on non-standard ports that made the regression check inapplicable.
8. **Builders never edit `memoryalter.md`, `checklist.md` or `progress.md`.** The CEO session
   writes them; builders read them and report. Otherwise "what we decided" and "what a
   builder believed we decided" stop being distinguishable — which is the ambiguity these
   files exist to remove. Every master prompt must say so.
9. **Never trust a merge without checking CI to completion.** Six merges in a row went red
   before anyone looked — the verification standard was written while its own enforcement
   was silently broken. `git push` then `gh run watch <id> --exit-status`, reading the real
   step list, every time. A local pass is not evidence a CI runner will agree.
10. **Grade review depth by blast radius.** Model Gateway has five direct dependents; a
   read-only registry does not.
11. **Record pre-provider scores as void before Phase 1 lands.** The first honest measurement
   will look like a regression, and someone will read it as one.
