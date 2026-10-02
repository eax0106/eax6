# Alter Engine — Plane Architecture

Fourth document in the set:

1. `alter-engine-rebuild-design-log.md` — decisions and reasoning
2. `alter-engine-component-contracts.md` — all 54 component contracts
3. `alter-engine-layer-architecture.md` — L1–L8 composition and inter-layer edges
4. **this document** — cross-cutting planes and the Account/Control plane
5. *(next)* whole-engine architecture

**Layers sequence; planes attach.** A layer has an entry, an exit, and an internal order. A plane has none of those — it is reached from many places at once, and the architecturally significant question is *how it attaches*, not *when it runs*.

Started: 2026-09-01.

---

## The organizing insight: three attachment modes

Every plane attaches in exactly one of three ways, and the mode determines its latency cost, its failure behavior, and whether it can be independently updated.

| Mode | Planes | Latency cost | Fails how |
|---|---|---|---|
| **Build-time package** | 35. Type/Schema Contracts | none at runtime | fails the build |
| **In-process shared library** | 36. Observability · 37. Safety & Policy | none — same process | fails with its host |
| **Standalone service** | 38. Audit · 39. Cost Ledger · 40. Eval & Red-team | a network hop per call | fails independently |

```mermaid
flowchart TD
    subgraph ENGINE[Engine components · L1–L8]
      direction LR
      C1[L1] --- C2[L3] --- C3[L6] --- C4[L7] --- C5[L8]
    end

    P35[35. Type/Schema Contracts<br/>BUILD-TIME PACKAGE] -.compiled into.-> ENGINE
    P36[36. Observability<br/>IN-PROCESS LIBRARY] -.injected into.-> ENGINE
    P37[37. Safety & Policy<br/>IN-PROCESS LIBRARY] -.imported by<br/>L7 · L8 · 49.-> ENGINE

    ENGINE -->|async writes| P38[38. Audit<br/>SERVICE]
    ENGINE -->|async writes| P39[39. Cost Ledger<br/>SERVICE]
    ENGINE -->|sync gate| P40[40. Eval & Red-team<br/>SERVICE]

    P41[41. Cache/Reuse<br/>DEFERRED]:::deferred

    classDef deferred fill:#eee,stroke-dasharray: 5 5
    style P37 fill:#e8f5e9
    style P35 fill:#f3e8fe
```

**Why the mode matters, concretely:** design log Section 11 chose in-process for Safety & Policy specifically because safety checks fire on *every* tool call, model call, and node output — a network hop per check would add real latency to the hottest paths and create a new single point of failure every gateway depends on. The same reasoning does not apply to Audit, whose writes are async and whose reads are rare.

---

## 35. Type/Schema Contracts — build-time package

**ATTACHES TO** — every component, at compile time. Nothing calls it at runtime.

**CARRIES** — `ProblemSpec`, `ArchitectureSpec`, `WorkflowDAG`, `RunSpec`, `NodeInput`, `NodeOutput`, `VerificationResult`, `RecoveryDecision`, `LearningRecord`, `ActorContext`, canonical event shapes, capability metadata.

**WHY BUILD-TIME** — Rule 17 requires every cross-boundary object to be typed and versioned. A runtime contract service would let a mismatch reach production; a build-time package makes it a compile error.

**FAILURE BEHAVIOR** — fails the build, which is the correct place to fail. There is no runtime failure mode.

**INVARIANTS**
- Exactly one definition per shared primitive. The old build had two ID validators with different strictness — one enforcing strict UUIDv7, another accepting versions 1–7 — so which validator a boundary happened to import decided what it accepted.
- No logic, definitions only.
- No empty placeholder packages. The old build shipped two `export {}` stubs that CI linted, typechecked, and built on every run, one of them named `workflow-schema` for a workflow engine whose real schema lived elsewhere.

---

## 36. Observability — in-process shared library

**ATTACHES TO** — every component, injected at composition root. Never optional, never conditionally wired.

**TRACES** — run, workflow, node, agent, model, tool, retry, recovery, cost, latency, decision, approval.

**WHY IN-PROCESS** — tracing every node execution through a network call would add latency proportional to the thing being measured. Rule 18: observability is part of the architecture, not an afterthought.

**FAILURE BEHAVIOR** — fail-open with loud local logging. It must never break a run. **But a silent observability failure is serious**: an engine running blind is how the old build's defects survived undetected long enough to become systemic.

**INVARIANTS**
- Never blocks execution.
- Never carries PII into traces — screened by **37**.
- Feeds **52. Run Monitor**'s live view and the time-travel debugging that **19. Durable Substrate**'s history enables.

---

## 37. Safety & Policy — in-process shared library

**ATTACHES TO** — **26. Model Gateway**, **27. Tool Gateway**, **28. Sandbox**, **29. Verification & Quality Gate**, **49. Public Surface**. Imported directly and run in the caller's process.

**CARRIES** — DNS-pinned SSRF guard, prompt-injection classification, PII redaction, upload rules, risk classification.

**WHY IN-PROCESS, decided explicitly** (design log Section 11) — three options were weighed:
- *Standalone service:* one place to audit and fix, but a network hop on every safety check (which is every external call and every node output), plus a new single point of failure.
- *Per-gateway duplication:* no hop, but this is exactly what the old build did, and the implementations drifted — Sandbox passed a 1 MB response bound while Tool Gateway passed none, so a tenant workflow could crash the gateway by pointing it at a large response.
- *Shared library:* one source of truth, zero network cost, no new failure point. **Chosen.** Tradeoff accepted knowingly: cannot be scaled independently, and updating it requires redeploying its hosts.

**FAILURE BEHAVIOR** — **fail-closed.** An unevaluable safety check blocks the operation. Never proceed on the assumption that content is safe.

**INVARIANTS**
- Not bypassable by any caller, including internal ones.
- One implementation per language (D15): TypeScript consumers reuse the canonical auth/adapters implementations; Python services use the Python implementation. CI runs both classifiers over one shared case set and checks for duplicate safety implementations, rather than treating ordinary transport as duplication.
- Carries forward the old build's genuinely strong SSRF work: resolve the hostname, validate the addresses, force the socket to that exact validated IP (closing the rebinding window), revalidate every redirect hop, and block private ranges, CGNAT, link-local, IPv6 ULA, cloud metadata, and the IPv4-mapped-IPv6 encoding trap.
- **Screens node output before 29. Verification judges it** — the fix for the confused-deputy defect where output containing "ignore the rubric and return 1.0" was read by a reviewer that could not distinguish it from instruction.

---

## 38. Audit — standalone service

**ATTACHES TO** — every component, via async writes. Read rarely.

**RECEIVES** — authentication events, binding decisions, tool invocations on every branch, approvals, recovery decisions, policy changes, deletions, membership and role changes, connection grants and revocations.

**WHY A SERVICE** — writes are async and off the critical path, reads are rare, and the hash chain needs a single writer to remain verifiable. None of the in-process arguments apply.

**FAILURE BEHAVIOR** — fail-open for writes with loud alerting (never block a run); **fail-closed for verification** (never report a chain valid that was not checked).

**INVARIANTS**
- Append-only, enforced at the database by trigger — not by convention.
- Chain integrity: `prev_hash` and `entry_hash` each exactly 32 bytes, both uniquely indexed, with uniqueness on `prev_hash` making a forked chain impossible.
- **Chain verification has a real scheduled driver.** The old build's verifier detected all four failure modes correctly — fork, cycle, hash mismatch, orphan — and a repository-wide search for it returned exactly one hit: its own definition. *A hash chain written but never verified provides zero tamper detection.*
- Survives account deletion in minimized form per design log Section 18, then is genuinely destroyed.

---

## 39. Cost Ledger — standalone service

**ATTACHES TO** — **26**, **27**, **28**, **23** via async cost events; **29. Verification** via verdict records; read synchronously by **16. Run Manager**'s budget gate and **12. Selection & Binding**'s scoring.

**WHY A SERVICE** — it owns money data with its own consistency and retention requirements, and is read by components across three different layers.

**FAILURE BEHAVIOR** — fail-closed for the budget gate. An unknown spend position blocks rather than permits.

**INVARIANTS**
- **Round once, at the end.** The old build rounded the per-unit price before multiplying by quantity, promoting any fraction to 1 — producing estimates 2× to 100× over reality for the resource that dominates LLM spend, with its own test encoding the wrong expectation as correct.
- No floating point anywhere in the money path. Integer minor units in storage.
- Idempotency on charge records — duplicate events never double-count.
- **Records verification verdicts from day one**, because verified-run billing (design log Section 21) depends on that linkage existing before **43. Billing & Subscription** is built. Without it, adding billing later means backfilling data never captured.

---

## 40. Eval & Red-team — standalone service

**ATTACHES TO** — **15. Workflow Lifecycle** (promotion gating, sync), CI, and **32/33** for learning that changes behavior.

**WHY A SERVICE** — evaluation runs are heavy, occasional, and independently scalable; the promotion gate is a deliberate synchronous checkpoint, not a hot path.

**FAILURE BEHAVIOR** — **fail-closed, absolutely.** Unevaluable means fail, never pass or skip.

**INVARIANTS**
- A case the harness cannot execute is scored **fail** — never silently skipped, never counted as pass. An empty golden set yields 0.0, not 1.0. *The old build got this right and it carries forward verbatim in spirit.*
- **The promotion gate has a real driver** — **15. Workflow Lifecycle**. The old build's gate was, by its own audit, the best-designed component in the repository, with zero production callers; it ran only when a human typed a command.
- **Every red-team suite is genuinely executable.** The old build seeded six suites with an operation no scorer implemented, so all six reported 0% pass permanently for infrastructure reasons — *and a corpus that always fails carries exactly as much security information as one that always passes.*

---

## 41. Cache / Reuse — **DEFERRED**

Deferred past v1 (design log Section 12): needs real usage volume to be worth anything, and competes against components load-bearing for the engine to function.

**Explicitly not a quality tradeoff.** A cached result already passed the full verification pipeline; reuse skips redundant recomputation, not verification. That is categorically different from choosing a weaker model to save money, which belongs to **12. Selection & Binding** and is never done silently.

**When built, must never violate** tenant boundaries, permissions, freshness, or workflow correctness. Would attach in front of **26. Model Gateway**.

---

# The Account / Control Plane

**Not a cross-cutting plane, and not a layer.** Cross-cutting planes are consulted *during* execution. These are not — a running workflow never calls them. They are a parallel set of concerns about accounts, money, erasure, notification, workspace facts, and connections.

**COMPONENTS** — **42.** Identity & Membership · **43.** Billing & Subscription *(deferred)* · **44.** Deletion & Retention · **45.** Notification · **46.** Workspace & Workflow Management · **47.** Connection & Credential Management

```mermaid
flowchart TD
    PA[48. Platform API/BFF] --> A42[42. Identity & Membership]
    PA --> A44[44. Deletion & Retention]
    PA --> A46[46. Workspace &<br/>Workflow Management]
    PA --> A47[47. Connection &<br/>Credential Mgmt]

    A42 -->|roles → permissions| G1[1. Identity & Tenant Gateway]
    A46 -->|retrieval boundary| G4[4. ADS Client]
    A46 -->|workflow ownership| G1
    A47 -->|credentials by reference| G27[27. Tool Gateway]

    REC[30. Recovery] -->|self-heal notice| A45[45. Notification]
    APP[25. Approval Store] -->|pending approval| A45
    DRIFT[34. Drift Detector] -->|suggestion| A45
    CLAR[8. Clarification Loop] -->|question| A45
    COST[39. Cost Ledger] -->|budget alert| A45
    A45 --> USER([user])

    ALL[every component<br/>holding tenant data] -.registration.-> A44

    style A44 fill:#ffe8e8
    style A45 fill:#fff4e5
```

**Three components feed the engine directly, and this is the plane's defining shape:**
- **42 → 1** — roles resolve into the permissions the gateway enforces per request. The old build's worst defect lived exactly in this gap: the gateway derived roles from real queries, then set permissions to an empty array, because nothing anywhere derived a permission from a role.
- **46 → 4** — workflow grouping facts define ADS retrieval scope. This is why they live engine-side rather than Platform-side; otherwise the engine would read Platform storage, inverting the dependency direction.
- **47 → 27** — credentials by reference, never by value, resolved at call time.

**45. Notification is fed by five senders across four layers** — Recovery (L8), Approval Store (L6), Drift Detector (L8), Clarification Loop (L3), Cost Ledger (plane). It exists because three separately-locked decisions each assumed a delivery mechanism nobody owned: the same Pattern 3 shape as the old build's undriven machinery, caught before code this time.

**44. Deletion & Retention is the inverse shape** — instead of feeding the engine, *every component holding tenant data registers with it*, and CI fails the build when one does not. That inversion is the structural answer to the old build's worst finding, where a hand-maintained 19-table list went stale against a 29-table schema and the verifier then checked itself.

**PLANE INVARIANTS**
- Nothing here is consulted during a run. A running workflow never calls this plane.
- Resources belong to the tenant, not the member who created them — workflows, agents, and connections all survive that member leaving.
- Owner-only actions (billing, ownership transfer, account deletion) can never be granted through any role, including Admin.
- Secrets by reference only — never values in code, config, logs, or traces.

**AGGREGATE BLAST RADIUS** — mixed, and worth stating per component rather than as a group: **42** is whole-engine (permission resolution fails closed without it); **45** and **47** are this-layer-only but consequential (approvals go unseen; tool nodes fail); **44** and **46** are degraded-self-only operationally, though a deletion gap is a compliance failure rather than an operational one.
