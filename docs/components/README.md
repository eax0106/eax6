# Components

One folder per component. Each README carries what the component is, where its code actually
lives, its state as verified in the readiness assessment, how it lines up against the design log,
and what finished looks like.

**61 components.** The code itself is an Nx monorepo of 15 apps and 6 packages — most components
live *inside* an app rather than beside it, so these folders are the map, not the territory. Each
one points at the real paths.

| Key | Meaning |
|---|---|
| `ALIGNED` | The design log imposes no requirement this component fails. |
| `NEEDS-LOGIC` | The design log supplies logic the component is missing. |
| `CONFLICT` | The design log says something different from the component's current shape. |
| `SILENT` | The design log does not cover this component. |

Blast radius and fail mode are a **first pass, not ratified** — design log §29 lists them as an
open item never applied to a specific component list.

---

## Category 1 — works end to end

25 components, all verified live against main on 4–6 September 2026. **Do not change their logic or code during revival.**

| Component | Layer | Alignment | Blast radius |
|---|---|---|---|
| [Architecture compile path](architecture-compile-path/README.md) | L5 | `NEEDS-LOGIC` | `this-layer-only` |
| [Audit Ledger](audit-ledger/README.md) | L8 | `NEEDS-LOGIC` | `this-layer-only` |
| [Blackboard](blackboard/README.md) | L6 | `ALIGNED` | `this-layer-only` |
| [Capability Registry](capability-registry/README.md) | L3 | `NEEDS-LOGIC` | `this-layer-only` |
| [Conversation Manager](conversation-manager/README.md) | L1 | `ALIGNED` | `degraded` |
| [Cost Ledger](cost-ledger/README.md) | L8 | `NEEDS-LOGIC` | `this-layer-only` |
| [Durable Run Queue](durable-run-queue/README.md) | L6 | `ALIGNED` | `this-layer-only` |
| [Durable Substrate](durable-substrate/README.md) | L6 | `ALIGNED` | `whole-engine` |
| [Eval Harness](eval-harness/README.md) | L8 | `ALIGNED` | `nothing` |
| [Execution Workers](execution-workers/README.md) | L6 | `ALIGNED` | `this-layer-only` |
| [Executor](executor/README.md) | L6 | `ALIGNED` | `whole-engine` |
| [Gate node type](node-gate/README.md) | L6 | `ALIGNED` | `degraded` |
| [Graph Compiler](graph-compiler/README.md) | L5 | `ALIGNED` | `this-layer-only` |
| [HumanApproval node type](node-humanapproval/README.md) | L6 | `NEEDS-LOGIC` | `degraded` |
| [Merge node type](node-merge/README.md) | L6 | `ALIGNED` | `degraded` |
| [Model Gateway](model-gateway/README.md) | L7 | `ALIGNED` | `whole-engine` |
| [Node Type Registry](node-type-registry/README.md) | L6 | `ALIGNED` | `this-layer-only` |
| [Policy Store](policy-store/README.md) | L8 | `NEEDS-LOGIC` | `this-layer-only` |
| [Problem Understanding](problem-understanding/README.md) | L2 | `ALIGNED` | `this-layer-only` |
| [Provisioning](provisioning/README.md) | L6 | `ALIGNED` | `degraded` |
| [Run Manager](run-manager/README.md) | L6 | `NEEDS-LOGIC` | `this-layer-only` |
| [Sandbox](sandbox/README.md) | L7 | `ALIGNED` | `degraded` |
| [SandboxExec node type](node-sandboxexec/README.md) | L6 | `ALIGNED` | `degraded` |
| [Synthesis](synthesis/README.md) | L8 | `ALIGNED` | `degraded` |
| [Verification & Quality Gate](verification-quality-gate/README.md) | L8 | `NEEDS-LOGIC` | `whole-engine` |

## Category 2 — needs wiring only

10 components. A finished screen and a working backend that were never introduced. Routes answer `403 RBAC_ROLE_DENIED`, not 404 — the backend exists and is authorized. Cheapest work on the board.

| Component | Layer | Alignment | Blast radius |
|---|---|---|---|
| [C14 Marketplace](marketplace/README.md) | platform-web | `ALIGNED` | `nothing` |
| [C15 Publisher & Payout](publisher-payout/README.md) | platform-web | `ALIGNED` | `nothing` |
| [C16 Tool Registry](tool-registry-surface/README.md) | platform-web | `ALIGNED` | `nothing` |
| [C17 Notifications](notifications/README.md) | platform-web | `ALIGNED` | `nothing` |
| [C18 Cost & Billing](cost-billing/README.md) | platform-web | `ALIGNED` | `nothing` |
| [C19 Discovery](discovery/README.md) | platform-web | `ALIGNED` | `nothing` |
| [C20 Media Services — removed](media-services/README.md) | — | owner removed 12 October 2026 | `nothing` |
| [C22 Benchmarking](benchmarking/README.md) | platform-web | `ALIGNED` | `nothing` |
| [C23 Admin Console](admin-console/README.md) | platform-web | `ALIGNED` | `nothing` |
| [C26 Search](search/README.md) | platform-web | `ALIGNED` | `nothing` |

## Category 3 — needs fixes or missing methods

12 components. Both ends exist and the call is made; something along the path is wrong. A source read marks these as finished, because from the source both halves look complete.

| Component | Layer | Alignment | Blast radius |
|---|---|---|---|
| [Agent Auto-Creation](agent-auto-creation/README.md) | L4 | `CONFLICT` | `this-layer-only` |
| [C13 Trigger Management](trigger-management/README.md) | platform | `CONFLICT` | `nothing` |
| [C5 Run Experience](run-experience/README.md) | platform | `ALIGNED` | `nothing` |
| [C6 Human Action Centre](human-action-centre/README.md) | platform | `CONFLICT` | `nothing` |
| [C7 Project Studio](project-studio/README.md) | platform | `ALIGNED` | `nothing` |
| [C8 Deployment Manager](deployment-manager/README.md) | platform | `SILENT` | `nothing` |
| [Capability Resolver](capability-resolver/README.md) | L3 | `NEEDS-LOGIC` | `this-layer-only` |
| [Drift Detector](drift-detector/README.md) | L8 | `NEEDS-LOGIC` | `degraded` |
| [Memory & Learning](memory-learning/README.md) | L8 | `SILENT` | `this-layer-only` |
| [Recovery](recovery/README.md) | L8 | `CONFLICT` | `whole-engine` |
| [Selection & Binding](selection-binding/README.md) | L4 | `NEEDS-LOGIC` | `whole-engine` |
| [Tool Gateway](tool-gateway/README.md) | L7 | `NEEDS-LOGIC` | `degraded` |

## Category 4 — build from scratch

4 components. Two were never implemented. Two run today and still belong here, because their limit comes from where the boundary was drawn — porting them reproduces the flaw exactly.

| Component | Layer | Alignment | Blast radius |
|---|---|---|---|
| [Architecture Synthesizer](architecture-synthesizer/README.md) | L4 | `NEEDS-LOGIC` | `whole-engine` |
| [C9 Repository Manager](repository-manager/README.md) | platform | `SILENT` | `nothing` |
| [Planner](planner/README.md) | L2 | `NEEDS-LOGIC` | `this-layer-only` |
| [Voice](voice/README.md) | engine | `SILENT` | `nothing` |

## Category 5 — not assessable yet

10 components, held out of the four deliberately. None is known to be broken; none has earned a category. Of three components previously counted as working on a source read alone, **one worked, one failed its first request, and one had no surface to call.**

| Component | Layer | Alignment | Blast radius |
|---|---|---|---|
| [C10 Knowledge Management](knowledge-management/README.md) | platform | `SILENT` | `nothing` |
| [C21 Comms Channels](comms-channels/README.md) | platform | `SILENT` | `nothing` |
| [C24 Platform Jobs](platform-jobs/README.md) | platform | `SILENT` | `nothing` |
| [C25 Streaming Gateway](streaming-gateway/README.md) | platform | `SILENT` | `nothing` |
| [C27 Localization](localization/README.md) | platform | `SILENT` | `nothing` |
| [ads-core](ads-core/README.md) | engine | `NEEDS-LOGIC` | `degraded` |
| [auth package](pkg-auth/README.md) | package | `NEEDS-LOGIC` | `whole-engine` |
| [contracts package](pkg-contracts/README.md) | package | `NEEDS-LOGIC` | `whole-engine` |
| [shared-clients package](pkg-shared-clients/README.md) | package | `NEEDS-LOGIC` | `this-layer-only` |
| [tenancy package](pkg-tenancy/README.md) | package | `NEEDS-LOGIC` | `whole-engine` |

---

## Alignment totals

| Alignment | Count |
|---|---|
| `ALIGNED` | 29 |
| `NEEDS-LOGIC` | 19 |
| `CONFLICT` | 4 |
| `SILENT` | 9 |

**61 components total.**

Related: [`../memoryalter.md`](../memoryalter.md) holds every decision and why it was made.
[`../checklist.md`](../checklist.md) holds the work, numbered to match the action plan.
