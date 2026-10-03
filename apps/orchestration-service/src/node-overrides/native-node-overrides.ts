import { createFetchSelectionBindingHttpClient } from "@alterx/adapters";
import { CompiledDagSchema, NodeOverrideComparisonSchema, NodeOverrideThresholdsSchema, applyNodeOverride, type CompiledDag } from "@alterx/contracts";
import { expect } from "vitest";
import { WorstCaseRunCostEstimator } from "../budgets/worst-case-run-cost-estimator";
import type { OrchestrationTenantStore } from "../workflow-read/workflow-read.service";
import { NodeOverridesService } from "./node-overrides.service";
import { uuidV7 } from "../trigger-bindings/ids";

// Registry protocol and price providers are controlled edges here. The separate
// Python PostgreSQL test measures actual registry storage and ranking facts.
export function nativeOverrideService(store: OrchestrationTenantStore, url: string, token: string) {
  const estimator = new WorstCaseRunCostEstimator({
    modelsFor: async alias => [{ provider: "fixture", modelId: alias }],
    maxTokensPerCall: async () => 1000,
  }, {
    worstCase: async ({ lines }) => ({ billableMinor: lines.reduce((total, line) => total + (line.models[0]!.modelId === "CEILING" ? 2500 : 2000), 0), unpricedLines: 0 }),
    runsAverage: async () => { throw new Error("Override comparison must price the D4 bound, not historical averages"); },
  });
  return new NodeOverridesService(store, estimator, createFetchSelectionBindingHttpClient(() => token), url, NodeOverrideThresholdsSchema.parse({}));
}

export async function exerciseNativeOverrides(input: {
  store: OrchestrationTenantStore; baseUrl: string; tenant: string; workspace: string;
  otherWorkspace: string; otherTenant: string; headers: (claims?: Record<string, unknown>) => Record<string, string>;
}) {
  const workflow = `wf_${uuidV7()}`, version = `wfv_${uuidV7()}`;
  const selection = { binding: { record_id: "native-original", version: 2, kind: "model" as const, rationale: "Recorded native fit", score: 0.88, factors: { reliability: 0.9 } }, policy: { reliability_weight: 0.4, latency_weight: 0.3, cost_weight: 0.3 }, required_capabilities: ["text"], required_model_alias: "ADVANCED" as const, model_alias: "FAST" as const };
  const original: CompiledDag = { schema_version: "v1", entry_node_keys: ["work"], success_criteria: ["Keep the report."], nodes: [{ key: "work", type: "LLMTask", config: { model_alias: "FAST", prompt: "Report" }, metadata: { ui: {}, selection_binding: selection } }], edges: [], waves: [{ key: "first", order: 0, node_keys: ["work"], depends_on: [] }] };
  await input.store.withTenant(input.tenant, async tx => {
    await tx.query("INSERT INTO workflows(id,tenant_id,workspace_id,name) VALUES($1,$2,$3,'Native node overrides')", [workflow, input.tenant, input.workspace]);
    await tx.query("INSERT INTO workflow_versions(id,tenant_id,workflow_id,version,compiled_dag,dag_schema_version,status) VALUES($1,$2,$3,1,$4::jsonb,'v1','compiled')", [version, input.tenant, workflow, JSON.stringify(original)]);
  });
  const edited = structuredClone(original);
  edited.nodes[0]!.metadata.selection_binding!.binding.rationale = "Submitted replacement";
  const url = `${input.baseUrl}/api/v1/workflows/${workflow}`;
  const compare = { nodeKey: "work", choice: { kind: "model", value: "CEILING" }, dag: edited };
  expect((await fetch(`${url}/node-overrides/compare`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(compare) })).status).toBe(401);
  for (const claims of [{ workspace_id: `ws_${input.otherWorkspace}` }, { tenant_id: `ten_${input.otherTenant}` }]) {
    expect((await fetch(`${url}/node-overrides/compare`, { method: "POST", headers: input.headers(claims), body: JSON.stringify(compare) })).status).toBe(404);
  }
  const response = await fetch(`${url}/node-overrides/compare`, { method: "POST", headers: input.headers(), body: JSON.stringify(compare) });
  expect(response.status).toBe(201);
  const advice = NodeOverrideComparisonSchema.parse(await response.json());
  expect(advice.original.selection).toEqual(selection);
  expect(advice.original.choice).toEqual({ kind: "model", value: "FAST" });
  expect(advice.candidate).toMatchObject({record_id:"native-candidate",score:0.7});
  expect(advice.cost).toEqual({ currency: "INR", before_minor: 2000, after_minor: 2500 });
  expect(advice.warnings.some(warning => warning.code === "cost")).toBe(true);
  expect(advice.validation.valid).toBe(true);
  edited.nodes[0]!.config = applyNodeOverride(edited.nodes[0]!.config, { kind: "model", value: "CEILING" });
  const save = await fetch(url, { method: "PATCH", headers: input.headers(), body: JSON.stringify({ dag: edited }) });
  expect(save.status).toBe(200);
  const detail = await fetch(url, { headers: input.headers() });
  const saved = (await detail.json() as { dag: CompiledDag }).dag;
  expect(saved.nodes[0]!.config).toMatchObject({ model_alias: "CEILING", manual_model_override: true });
  expect(saved.nodes[0]!.metadata.selection_binding).toEqual(selection);
  expect(saved.nodes[0]!.metadata.original_choice).toEqual({ kind: "model", value: "FAST" });
  expect(saved.success_criteria).toEqual(original.success_criteria);
  const compiled = await fetch(`${url}/actions/compile`, { method: "POST", headers: input.headers(), body: "{}" });
  expect(compiled.status).toBe(201);
  const rows = await input.store.withTenant(input.tenant, tx => tx.query<{ compiled_dag: unknown }>("SELECT compiled_dag FROM workflow_versions WHERE tenant_id=$1 AND workflow_id=$2 ORDER BY version DESC", [input.tenant, workflow]));
  expect(rows.rows).toHaveLength(2);
  const newest = CompiledDagSchema.parse(rows.rows[0]!.compiled_dag);
  expect(newest.nodes[0]!.config.model_alias).toBe("CEILING");
  expect(newest.nodes[0]!.metadata.original_choice).toEqual({ kind: "model", value: "FAST" });
  expect(newest.nodes[0]!.metadata.selection_binding).toEqual(selection);
  const invalid = structuredClone(saved);
  invalid.nodes.push({ key: "orphan", type: "LLMTask", config: { model_alias: "FAST" }, metadata: { ui: {} } });
  invalid.waves[0]!.node_keys.push("orphan");
  expect((await fetch(url, { method: "PATCH", headers: input.headers(), body: JSON.stringify({ dag: invalid }) })).status).toBe(400);
  expect((await fetch(url, { headers: input.headers() }).then(result => result.json()) as { dag: CompiledDag }).dag).toEqual(saved);
  return workflow;
}
