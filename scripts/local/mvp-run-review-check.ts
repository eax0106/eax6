// Measures a template's run-level success criteria on the local MVP stack:
// each trial replays one fixed run outcome through the real end-of-run review
// (the same Verify Gate call PostgresRunAcceptanceCheck makes), so only the
// criteria wording varies. Every trial is a fresh tenant and run, so the
// gateway's per-tenant cache never replays an earlier verdict, and the guarded
// gateway's spend permit is opened for that trial only.
//
//   pnpm exec tsx scripts/local/mvp-run-review-check.ts --plan=scripts/local/knowledge-qa-run-review.json [--only=<variant name>] [--repeat=5] [--apply]
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { v7 as uuidv7 } from "uuid";
import { VerifyServiceClient } from "@alterx/adapters";

import { VERIFY_CLIENT_PROTO_PATH } from "../../apps/orchestration-service/src/registry/nodeexec-grpc.constants";
import { VerifyGateService } from "../../apps/orchestration-service/src/registry/verify-gate.service";
import { grpcServices, serviceEnvironment } from "./mvp-stack.mjs";

interface Variant { name: string; template_file: string }
interface Case { name: string; expected: "pass" | "fail"; outputs: Record<string, unknown> }
interface Plan { variants: Variant[]; cases: Case[] }

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const apply = process.argv.includes("--apply");
const repeat = Number(arg("repeat") ?? 5);
const plan = JSON.parse(readFileSync(arg("plan") ?? "", "utf8")) as Plan;
const only = arg("only");
if (only !== undefined) plan.variants = plan.variants.filter((variant) => variant.name === only);
if (plan.variants.length === 0) throw new Error(`no variant named ${only}`);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) throw new Error("--repeat must be 1-10");

// Run from the repository root, as the other spend scripts are.
const root = resolve(".");
const criteria = (file: string) =>
  (JSON.parse(readFileSync(resolve(root, file), "utf8")) as { skeleton: { success_criteria: string[] } }).skeleton.success_criteria;
const trials = plan.variants.length * plan.cases.length * repeat;
console.log(JSON.stringify({ plan: { variants: plan.variants.map((v) => v.name), cases: plan.cases.length, repeat, trials, apply } }));
if (!apply) { console.log("Plan only; add --apply with owner spend approval."); process.exit(0); }

const state = JSON.parse(readFileSync(resolve(root, "tmp/local-mvp/state.json"), "utf8")) as { ready?: boolean; processes: { name: string; pid: number }[] };
const gateway = state.processes.find((row) => row.name === "model-gateway");
if (!state.ready || gateway === undefined) throw new Error("No ready MVP stack; run scripts/local/mvp-up.sh");
const env = serviceEnvironment() as Record<string, string>;
Object.assign(process.env, env);
const address = (name: string) => grpcServices(env).find((row: { name: string }) => row.name === name)!.address as string;
const verify = new VerifyGateService(new VerifyServiceClient({ address: address("verification-service"), protoPath: VERIFY_CLIENT_PROTO_PATH,
  authorization: `Bearer ${env["INTERNAL_SERVICE_TOKEN"]}` }));
const permitFile = resolve(root, "tmp/local-mvp/spend-permit.json");

async function main(): Promise<void> {
  const rows: Record<string, unknown>[] = [];
  for (const variant of plan.variants) {
    const successCriteria = criteria(variant.template_file);
    for (const testCase of plan.cases) {
      for (let trial = 1; trial <= repeat; trial++) {
        const tenantId = `ten_${uuidv7()}`, runId = `run_${uuidv7()}`;
        writeFileSync(permitFile, JSON.stringify({ gatewayPid: gateway!.pid, tenantId, runId }), { flag: "wx", mode: 0o600 });
        try {
          const scored = await verify.scoreNodeInline({ tenant_id: tenantId, run_id: runId, node_execution_id: `node_${uuidv7()}`,
            node_key: "__run_outcome__", node_type: "RunOutcome", config_json: "{}",
            output_json: JSON.stringify(testCase.outputs), success_criteria: successCriteria });
          const correct = (scored.verdict === "fail" ? "fail" : "pass") === testCase.expected;
          const details = JSON.parse(scored.details_json) as { rationale?: string; criteria?: { met: boolean; reason: string }[] };
          rows.push({ variant: variant.name, case: testCase.name, trial, runId, verdict: scored.verdict, score: scored.score, correct,
            // Which criterion the reviewer judged unmet: a run fails on any one, whatever its score.
            unmet: (details.criteria ?? []).flatMap((row, index) => (row.met ? [] : [{ index, reason: row.reason.slice(0, 300) }])),
            reason: correct ? undefined : String(details.rationale ?? "").slice(0, 300) });
        } catch (error: unknown) {
          rows.push({ variant: variant.name, case: testCase.name, trial, runId, verdict: "error", correct: false,
            error: error instanceof Error ? error.message : String(error) });
        } finally { rmSync(permitFile, { force: true }); }
        console.log(JSON.stringify(rows.at(-1)));
      }
    }
  }
  const summary = plan.variants.map((variant) => {
    const mine = rows.filter((row) => row["variant"] === variant.name);
    return { variant: variant.name, correct: mine.filter((row) => row["correct"] === true).length, trials: mine.length };
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
