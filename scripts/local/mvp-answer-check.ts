// Measures candidate prompts or model aliases for one template LLM step on the
// local MVP stack: each trial generates the step once and has the real Verify
// Gate judge it against the step's own success criteria, as a run would. Every
// trial is a fresh tenant and run, so the gateway's per-tenant cache never
// replays an earlier answer, and the guarded gateway's spend permit is opened
// for that trial only (same USD process ceiling as the template runner).
//
//   pnpm exec tsx scripts/local/mvp-answer-check.ts --variants=scripts/local/answer-variants.json [--repeat=5] [--apply]
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { v7 as uuidv7 } from "uuid";
import { ModelGatewayClient, VerifyServiceClient } from "@alterx/adapters";
import { lazyAuth0M2mTokenProviderFromEnvironment } from "@alterx/auth";

import { MODELGW_CLIENT_PROTO_PATH } from "../../apps/orchestration-service/src/conversation/grpc.constants";
import { LlmTaskHandler } from "../../apps/orchestration-service/src/registry/handlers/llmtask.handler";
import { VERIFY_CLIENT_PROTO_PATH } from "../../apps/orchestration-service/src/registry/nodeexec-grpc.constants";
import { VerifyGateService } from "../../apps/orchestration-service/src/registry/verify-gate.service";
import { grpcServices, serviceEnvironment } from "./mvp-stack.mjs";

interface Variant { name: string; model_alias: string; prompt: string }
interface Plan { template_id: string; node: string; success_criteria: string[];
  test_cases: { name: string; input: Record<string, unknown> }[]; variants: Variant[] }

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const apply = process.argv.includes("--apply");
const repeat = Number(arg("repeat") ?? 5);
const plan = JSON.parse(readFileSync(arg("variants") ?? "", "utf8")) as Plan;
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) throw new Error("--repeat must be 1-10");

// Run from the repository root, as the other spend scripts are.
const root = resolve(".");
const state = JSON.parse(readFileSync(resolve(root, "tmp/local-mvp/state.json"), "utf8")) as { ready?: boolean; processes: { name: string; pid: number }[] };
const gateway = state.processes.find((row) => row.name === "model-gateway");
if (!state.ready || gateway === undefined) throw new Error("No ready MVP stack; run scripts/local/mvp-up.sh");
const env = serviceEnvironment() as Record<string, string>;
Object.assign(process.env, env);
const address = (name: string) => grpcServices(env).find((row: { name: string }) => row.name === name)!.address as string;

const trials = plan.variants.length * plan.test_cases.length * repeat;
console.log(JSON.stringify({ plan: { template: plan.template_id, node: plan.node, variants: plan.variants.map((v) => `${v.name}:${v.model_alias}`),
  cases: plan.test_cases.length, repeat, trials, apply } }));
if (!apply) { console.log("Plan only; add --apply with owner spend approval."); process.exit(0); }

const modelGateway = new ModelGatewayClient({ address: address("model-gateway"), protoPath: MODELGW_CLIENT_PROTO_PATH,
  accessTokenProvider: lazyAuth0M2mTokenProviderFromEnvironment(process.env) });
const verify = new VerifyGateService(new VerifyServiceClient({ address: address("verification-service"), protoPath: VERIFY_CLIENT_PROTO_PATH,
  authorization: `Bearer ${env["INTERNAL_SERVICE_TOKEN"]}` }));
const handler = new LlmTaskHandler(modelGateway);
const permitFile = resolve(root, "tmp/local-mvp/spend-permit.json");

async function main(): Promise<void> {
const rows: Record<string, unknown>[] = [];
for (const variant of plan.variants) {
  for (const testCase of plan.test_cases) {
    for (let trial = 1; trial <= repeat; trial++) {
      const tenantId = `ten_${uuidv7()}`, runId = `run_${uuidv7()}`, nodeExecutionId = `node_${uuidv7()}`;
      const config = { model_alias: variant.model_alias, prompt: variant.prompt };
      // The live search step's own output when the workspace holds no documents.
      const inputs = { search: { results: [] }, intake: testCase.input };
      writeFileSync(permitFile, JSON.stringify({ gatewayPid: gateway.pid, tenantId, runId }), { flag: "wx", mode: 0o600 });
      try {
        const result = await handler.execute({ config, inputs, tenant_id: tenantId, run_id: runId, node_execution_id: nodeExecutionId,
          success_criteria: plan.success_criteria });
        const scored = await verify.scoreNodeInline({ tenant_id: tenantId, run_id: runId, node_execution_id: nodeExecutionId,
          node_key: plan.node, node_type: "LLMTask", config_json: JSON.stringify({ ...config, upstream_inputs: inputs }),
          output_json: JSON.stringify(result.output), success_criteria: plan.success_criteria });
        const output = result.output as Record<string, unknown>;
        rows.push({ variant: variant.name, case: testCase.name, trial, runId, verdict: scored.verdict, score: scored.score,
          supported: output["supported"], answer: output["answer"], sources: output["sources"],
          reason: scored.verdict === "pass" ? undefined : String(JSON.parse(scored.details_json).rationale ?? "").slice(0, 300) });
      } catch (error: unknown) {
        rows.push({ variant: variant.name, case: testCase.name, trial, runId, verdict: "error", error: error instanceof Error ? error.message : String(error) });
      } finally { rmSync(permitFile, { force: true }); }
      console.log(JSON.stringify(rows.at(-1)));
    }
  }
}
const summary = plan.variants.map((variant) => {
  const mine = rows.filter((row) => row["variant"] === variant.name);
  return { variant: variant.name, passed: mine.filter((row) => row["verdict"] === "pass").length, trials: mine.length };
});
const usage = readFileSync(resolve(root, "tmp/local-mvp/model-gateway.log"), "utf8").split("\n").flatMap((line) => {
  try { const row = JSON.parse(line).localSmokeUsage; return row && rows.some((r) => r["runId"] === row.runId) ? [row] : []; }
  catch { return []; }
});
console.log(JSON.stringify({ summary, modelCalls: usage.length }));
const evidence = arg("evidence-file");
if (evidence) writeFileSync(evidence, JSON.stringify({ summary, rows }, null, 2) + "\n");
}

main().then(() => process.exit(0), (error: unknown) => { console.error(error); process.exit(1); });
