# Selection & Binding

**Layer** L4 · **Plane** intelligence · **Category** 3 — needs fixes or missing methods

> Both ends exist and the call is made, and something along the path is wrong. A source read marks
> these as finished, because from the source both halves look complete.

## What it is

Chooses which agent runs a node and binds it. The component that decides quality and cost on the design path.

## Blast radius, fail mode and driver

**Contract 12 — Selection & Binding** ([`component-contracts.md`](../../architecture/component-contracts.md))

| | |
|---|---|
| Blast radius | this-layer-only. Same reasoning as Registry: running workflows continue on existing bindings; new design and rebind-class recovery stop. |
| Fail mode | fail-closed and loud. On policy unavailability, refuse or flag degraded — never silently substitute defaults. |
| Driver | invoked by Architecture Synthesizer on the design path; by Recovery on the run path; by **51. Canvas** (through Platform API) for critique-mode comparisons on manual override. *Driver test:* all three callers work — a fresh design binds, a recovery swap rebinds, and a manual override produces a real comparison. |

*From the contract (task C13, decision 0.7). The contract's done gates are targets, not gates that fail today.*

## Where the code lives

- `apps/intelligence-service/src/selection_binding`

## Current state

*Verbatim from the readiness assessment — engine verified against main 4–6 September 2026; platform reported as received and not independently verified.*

Moved out of wiring. A 30–40× latency and cost swap does not move the winner — **`agent_id ASC` decides it**. The correctly-scoring `/bind-architecture` exists unwired but has never run in the execution path, so this is a swap with migration risk, not a call.

Since verified further: **the candidate query applies no exact-capability filter at all.** Eligibility is tenant, workspace, status, tier and embedding similarity above a threshold — nothing checks that an agent actually has the capability asked for.

## Design-log alignment — `NEEDS-LOGIC`

Design log §8 and §12 both assume this scoring is real:

- **§8** makes it the machinery behind materiality pushback on manual overrides — *"the comparison itself isn't new machinery: it's the same Selection & Binding scoring already run to produce the default, just also shown to the user."* With no capability filter, there is nothing meaningful to show.
- **§12** names it the owner of any genuine cost-versus-quality tradeoff, explicitly distinct from caching.
- **§22 item 9** removes agent creation from this component entirely — see Agent Auto-Creation.

The mock makes this worse than it looks: local embeddings are per-dimension SHA-256, so `underwater.basket.weaving` scores **0.8740** against a summarisation agent while the genuinely relevant `text.summarisation` scores **0.8703**, against a threshold of 0.6. **Nonsense scores higher than the real thing**, and the capability route can therefore never produce a no-match locally.

## What the finished component looks like

- [ ] An unrelated capability request **fails to bind** instead of matching (Phase 3 done gate).
- [ ] The cheaper of two equivalent agents wins on cost.
- [ ] Similarity threshold re-tuned against real embeddings, not mock ones.
- [ ] `/bind-architecture` migrated in with a fallback, not swapped.

## Open issues

None.

## Where this sits in the plan

See [`checklist.md`](../../checklist.md).

---

*Alignment key: `ALIGNED` the design log imposes no requirement this component fails · `NEEDS-LOGIC` the log supplies logic the component is missing · `CONFLICT` the log says something different from the current shape · `SILENT` the log does not cover this component.*
