// D18 follow-up (5 October 2026): each starter template's test cases run once
// through real Simulate with real models, capped at USD 1 in total. Prints the
// call count and a planning estimate first; spends only with --apply.
//
//   pnpm exec tsx scripts/spend/template-check.ts [--apply] [--only=<template-id>,...]
//
// Needs a model-gateway on real Bedrock (scripts/run-service-aws.sh) and a
// verification-service using it; their addresses come from the environment
// (MODEL_GATEWAY_ADDRESS, VERIFY_SERVICE_ADDRESS, INTERNAL_SERVICE_TOKEN and
// the AUTH0_M2M_* settings). Templates are compiled exactly as instantiation
// compiles them, and each case runs through the engine's BenchmarkCaseSimulator
// with the same handlers and verifier the benchmark module composes, so no
// outside action ever executes. Exit 1 when any case does not pass.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { v7 as uuidv7 } from "uuid";
import { ModelGatewayClient, VerifyServiceClient } from "@alterx/adapters";
import { lazyAuth0M2mTokenProviderFromEnvironment } from "@alterx/auth";
import type { ConnectionRegistrySnapshot } from "@alterx/contracts";

import { BenchmarkCaseSimulator, type BenchmarkCaseResult } from "../../apps/orchestration-service/src/benchmark-simulation/benchmark-case-simulator";
import { compileTaskSkeletonToDag, parseTaskSkeleton } from "../../apps/orchestration-service/src/compiler/dag-builder";
import { MODELGW_CLIENT_PROTO_PATH } from "../../apps/orchestration-service/src/conversation/grpc.constants";
import { GateHandler } from "../../apps/orchestration-service/src/registry/handlers/gate.handler";
import { GroupChatHandler } from "../../apps/orchestration-service/src/registry/handlers/groupchat.handler";
import { LlmTaskHandler } from "../../apps/orchestration-service/src/registry/handlers/llmtask.handler";
import { MergeHandler } from "../../apps/orchestration-service/src/registry/handlers/merge.handler";
import { SynthesisHandler } from "../../apps/orchestration-service/src/registry/handlers/synthesis.handler";
import { YamlImportHandler } from "../../apps/orchestration-service/src/registry/handlers/yaml-import.handler";
import { NodeHandlerRegistry } from "../../apps/orchestration-service/src/registry/node-handler-registry";
import { VERIFY_CLIENT_PROTO_PATH } from "../../apps/orchestration-service/src/registry/nodeexec-grpc.constants";
import { VerifyGateService } from "../../apps/orchestration-service/src/registry/verify-gate.service";
import { bindTemplateSkeleton } from "../../apps/orchestration-service/src/workflow-templates/template-skeleton";
import { assertWithinCeiling } from "./spend-guard.mjs";

// Conservative planning estimate at 2,000 input and 1,024 output tokens.
// A planning estimate is not a hard input-token bound. The approved real check
// additionally uses a provider-side reservation before every paid call.
// Mumbai Nova on-demand rates from the AWS Price List, checked 2026-10-06:
// https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/ap-south-1/index.json
// Live policy: FAST global Nova 2 Lite; STANDARD Nova Lite; ADVANCED Nova Pro.
// 1.5x margin also covers cross-region routing.
const PER_CALL_USD = { FAST: (2000 * 0.00000035 + 1024 * 0.00000295) * 1.5,
  STANDARD: (2000 * 0.000000071 + 1024 * 0.000000284) * 1.5,
  ADVANCED: (2000 * 0.00000094 + 1024 * 0.00000376) * 1.5 };

const apply = process.argv.includes("--apply");
const tenantId = `ten_${uuidv7()}`;
const workspace = "018f4d6e-2b4a-7a3e-8c1a-0000000000d9";
const connection = "018f4d6e-2b4a-7a3e-8c1a-0000000000da";
const connections: ConnectionRegistrySnapshot[] = [{ tenant_id: tenantId.slice(4), workspace_id: workspace, connection_id: connection,
  connector_type: "postgres", status: "connected", secret_ref: `/alter/integrations/${tenantId.slice(4)}/${workspace}/${connection}`, source_revision: 1 }];

interface Template { template_id: string; skeleton: Record<string, unknown>; test_cases: { name: string; input: Record<string, unknown>; success_criteria: string[] }[] }
const dir = resolve("apps/intelligence-service/src/capability_registry/templates/v1");
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length).split(",");
const templates: Template[] = readdirSync(dir).filter((file) => file.endsWith(".json")).sort()
  .map((file) => JSON.parse(readFileSync(resolve(dir, file), "utf8")) as Template)
  .filter((template) => only === undefined || only.includes(template.template_id));
if (templates.length === 0) throw new Error("no template matches --only");

const compiled = new Map(templates.map((template) => {
  const bound = bindTemplateSkeleton(template.skeleton, { tenantId, environment: "local" }, connections);
  if (bound.missing.length > 0) throw new Error(`${template.template_id} still needs connections`);
  return [template.template_id, compileTaskSkeletonToDag(parseTaskSkeleton(JSON.stringify(bound.skeleton)), "v1")] as const;
}));

// Each model step generates once. Verification screens once, reviews once,
// and judges the criteria once when present. The final RunOutcome has criteria
// and therefore needs all three reviewer calls. Include even untaken branches.
const callsByAlias = { FAST: 0, STANDARD: 0, ADVANCED: 0 };
for (const template of templates) {
  for (const testCase of template.test_cases) {
    for (const node of compiled.get(template.template_id)!.nodes.filter(node => node.type === "LLMTask")) {
      const alias = node.config["model_alias"];
      if (alias !== "FAST" && alias !== "STANDARD") throw new Error("Template check prices only FAST/STANDARD generation");
      callsByAlias[alias]++;
      callsByAlias.FAST++;
      callsByAlias.ADVANCED += 1 + (node.success_criteria?.length ? 1 : 0);
    }
    callsByAlias.FAST++;
    callsByAlias.ADVANCED += 1 + (testCase.success_criteria.length ? 1 : 0);
  }
}
const calls = Object.values(callsByAlias).reduce((sum, count) => sum + count, 0);
const estimateUsd = callsByAlias.FAST * PER_CALL_USD.FAST + callsByAlias.STANDARD * PER_CALL_USD.STANDARD + callsByAlias.ADVANCED * PER_CALL_USD.ADVANCED;
console.log(JSON.stringify({ plan: { templates: templates.length, cases: templates.reduce((n, t) => n + t.test_cases.length, 0), maxModelCalls: calls, callsByAlias,
  estimateUsd: Number(estimateUsd.toFixed(4)), apply } }));
assertWithinCeiling(estimateUsd);
if (!apply) process.exit(0);

// Expectations come from the authored cases. Check recipients before model
// redaction makes distinct addresses indistinguishable to a semantic reviewer.
function checkPlannedActions(template: string, index: number, input: Record<string, unknown>, result: BenchmarkCaseResult): void {
  const expected: Record<string, string[][]> = {
    "lead-capture-crm-welcome": [["save_lead", "send_welcome"], []],
    "support-email-triage": [["to_billing"], ["to_escalations"]],
    "invoice-email-to-sheet": [["add_row"], []],
    "weekly-report-digest": [["send_digest"], ["send_digest"]],
    "knowledge-qa": [[], []],
    "meeting-notes-summary": [["send_summary"], ["send_summary"]],
    "brand-mention-alert": [["send_alert"], []],
    "whatsapp-faq-responder": [["escalate"], ["send_reply"]],
  };
  const actions = Object.entries(result.output).filter(([, value]) => {
    const planned = value as Record<string, unknown>;
    return planned["simulated"] === true && ["ToolCall:email.send", "ToolCall:database.insert", "ToolCall:whatsapp.send"].includes(String(planned["action"]));
  });
  assert.deepEqual(actions.map(([key]) => key).sort(), [...expected[template]![index]!].sort(), "planned outside actions match the case");
  for (const [key, value] of actions) {
    const args = (value as Record<string, unknown>)["arguments"] as Record<string, unknown>;
    if (key === "save_lead") assert.deepEqual(args["parameters"], [input["name"], input["email"], input["company"]]);
    else if (key === "add_row") assert.deepEqual(args["parameters"], ["SP-1042", "Sharma Print Works", null, "INR", 12000, 2160, 14160]);
    else {
      const recipient = key === "to_billing" ? "billing@example.com" : key === "to_escalations" ? "escalations@example.com"
        : key === "escalate" ? "support@example.com" : key === "send_welcome" ? input["email"]
        : key === "send_reply" ? input["from"] : key === "send_alert" ? input["alert_to"] : input["recipient"];
      assert.equal(args["to"], recipient, "planned recipient is the original case recipient");
      if (key === "to_billing" || key === "to_escalations") assert.equal(args["body"], input["body"]);
      if (key === "escalate") assert.equal(args["body"], input["text"]);
    }
  }
}

async function main(): Promise<number> {
  const modelGateway = new ModelGatewayClient({ address: process.env.MODEL_GATEWAY_ADDRESS!, protoPath: MODELGW_CLIENT_PROTO_PATH,
    accessTokenProvider: lazyAuth0M2mTokenProviderFromEnvironment(process.env) });
  const explained: string[] = [];
  const scoring = new VerifyGateService(new VerifyServiceClient({ address: process.env.VERIFY_SERVICE_ADDRESS!, protoPath: VERIFY_CLIENT_PROTO_PATH,
    authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN!}` }));
  // Keeps each failed review's reasons, so a failed case says why.
  const verifyGate = { scoreNodeInline: async (request: Parameters<VerifyGateService["scoreNodeInline"]>[0]) => {
    const scored = await scoring.scoreNodeInline(request);
    if (scored.verdict !== "pass") {
      const details = JSON.parse(scored.details_json) as { rationale?: string; criteria?: { criterion?: string; met?: boolean; reason?: string }[] };
      const unmet = (details.criteria ?? []).filter((judgement) => judgement.met === false).map((judgement) => `unmet: ${judgement.criterion} (${judgement.reason ?? ""})`);
      explained.push(`${request.node_key} ${scored.score}/${scored.threshold}: ${unmet.length > 0 ? unmet.join("; ") : details.rationale ?? scored.details_json}`.slice(0, 900));
    }
    return scored;
  } };

  const report: { template: string; case: string; verdict: string; score: number | null; error: string | null; steps: string; costUsd: number | null; tokens: number; reasons: string[] }[] = [];
  const evidence: BenchmarkCaseResult[] = [];
  let generationUsd = 0;
  for (const template of templates) {
    const dag = compiled.get(template.template_id)!;
    const workflowId = `wf_${uuidv7()}`;
    const simulator = new BenchmarkCaseSimulator(
      { previewRun: async () => ({ workspaceId: workspace, workflowVersionId: `wfv_${uuidv7()}`, compiledDag: dag }) },
      (verification) => new NodeHandlerRegistry([new GateHandler(verification), new MergeHandler(), new GroupChatHandler(), new YamlImportHandler(),
        new LlmTaskHandler(modelGateway), new SynthesisHandler(modelGateway, verification)]),
      verifyGate,
    );
    for (const [index, testCase] of template.test_cases.entries()) {
      explained.length = 0;
      const result: BenchmarkCaseResult = await simulator.simulateCase({ tenantId, workspaceId: `ws_${workspace}`, workflowId,
        caseId: `${template.template_id}-${index + 1}`, input: testCase.input, successCriteria: testCase.success_criteria });
      evidence.push(result);
      let plannedActionsPassed = false;
      try { checkPlannedActions(template.template_id, index, testCase.input, result); plannedActionsPassed = true; }
      catch (error: unknown) { explained.push(`Planned action check: ${error instanceof Error ? error.message : String(error)}`); }
      generationUsd += result.usage.estimatedCostUsd ?? 0;
      report.push({ template: template.template_id, case: testCase.name, verdict: plannedActionsPassed ? result.verdict : "fail", score: result.score, error: result.error,
        steps: result.steps.map((step) => `${step.key}:${step.status}${step.verdict ? `/${step.verdict}` : ""}`).join(" "),
        costUsd: result.usage.estimatedCostUsd, tokens: result.usage.inputTokens + result.usage.outputTokens, reasons: [...explained] });
      console.log(JSON.stringify(report.at(-1)));
    }
  }
  const passed = report.filter((row) => row.verdict === "pass").length;
  const evidenceFile = process.argv.find(arg => arg.startsWith("--evidence-file="))?.slice("--evidence-file=".length);
  if (evidenceFile) writeFileSync(evidenceFile, JSON.stringify({ report, cases: evidence }, null, 2) + "\n");
  console.log(JSON.stringify({ summary: { cases: report.length, passed, failed: report.length - passed,
    generationUsdReported: Number(generationUsd.toFixed(6)), planningEstimateUsd: Number(estimateUsd.toFixed(4)) } }));
  return passed === report.length ? 0 : 1;
}

main().then((code) => process.exit(code), (error: unknown) => { console.error(error); process.exit(1); });
