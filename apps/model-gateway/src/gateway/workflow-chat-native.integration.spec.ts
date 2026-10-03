import { execFile } from "node:child_process";
import { sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { CostClient, FailoverModelProvider, ModelGatewayClient, startModelgwGrpcTransport } from "@alterx/adapters";
import { createMockCacheProvider, createMockConfigProvider, createMockEmbeddingProvider, createMockModelProvider,
  createMockPIIRedactionProvider, createMockQueueProvider, type ModelProvider } from "@alterx/shared-clients";
import type { CostIngestCostEventRequest } from "@alterx/contracts";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { expect, it } from "vitest";
import { AppModule } from "../app.module";
import { OperationalConfigProvider } from "../operations/operational-config-provider";

it.runIf(Boolean(process.env.WORKFLOW_CHAT_NATIVE_ASSISTANT))("answers through the authenticated Model Gateway and persists actual workspace cost", async () => {
  const fixture = JSON.parse(process.env.WORKFLOW_CHAT_NATIVE_ASSISTANT!) as {
    baseUrl: string; controlUrl: string; runsAddress: string; tenant: string; workspace: string; user: string; privateKey: string; registryToken: string; directory: string;
    observed: { workflowId: string; runId: string; nodeId: string; foreignWorkflowId: string; foreignRunId: string; oldRunId: string };
  };
  const path = join(fixture.directory, "cost-config.json"); writeFileSync(path, JSON.stringify(fixture), { mode: 0o600 });
  const reportPath = join(fixture.directory, "cost-report.json");
  const costResult = promisify(execFile)(process.execPath, [resolve("node_modules/vitest/vitest.mjs"), "run", "apps/cost-ledger-service/src/ingest/workflow-chat-native.integration.spec.ts", "--maxWorkers=1", "--reporter=json", `--outputFile=${reportPath}`], {
    env: { ...process.env, WORKFLOW_CHAT_NATIVE_COST: path }, timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  }).then(() => undefined, error => error as Error);
  const costFailure = () => {
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as { testResults: { message?: string; assertionResults: { failureMessages: string[] }[] }[] };
    return report.testResults.flatMap(file => [file.message ?? "", ...file.assertionResults.flatMap(test => test.failureMessages)]).join("\n");
  };
  let app: NestFastifyApplication | undefined;
  try {
    const deadline = Date.now() + 30000;
    while (!existsSync(join(fixture.directory, "cost-ready.json"))) {
      if (existsSync(reportPath)) { await costResult; throw Error(costFailure()); }
      if (Date.now() > deadline) throw Error("Native Cost Ledger did not become ready");
      await new Promise(done => setTimeout(done, 25));
    }
    const cost = JSON.parse(readFileSync(join(fixture.directory, "cost-ready.json"), "utf8")) as { address: string; baseUrl: string };
    const jwt = (claims: Record<string, unknown>) => { const input = [{ alg: "RS256", kid: "chat-native" }, claims].map(part => Buffer.from(JSON.stringify(part)).toString("base64url")).join("."); return `${input}.${sign("RSA-SHA256", Buffer.from(input), fixture.privateKey).toString("base64url")}`; };
    const machine = () => { const now = Math.floor(Date.now() / 1000); return jwt({ iss: "https://chat.test/", aud: "alter-engine", iat: now, exp: now + 60 }); };
    const client = new CostClient({ address: cost.address, protoPath: resolve("packages/contracts/proto/alter/cost/v1/cost.proto"), accessTokenProvider: { getAccessToken: async () => machine() } });
    const calls: Parameters<ModelProvider["invoke"]>[0][] = [];
    const model = createMockModelProvider({ invoke: async request => {
      calls.push(request);
      const payload = JSON.parse(request.inputJson);
      expect(payload).not.toHaveProperty("tools"); expect(payload).not.toHaveProperty("actions");
      expect(payload.messages[0].content).toContain("read-only workspace assistant");
      expect(payload.messages[1].content).toContain("capturedAt");
      const snapshot = JSON.parse(payload.messages[1].content).snapshot;
      expect(snapshot.workflows).toContainEqual(expect.objectContaining({ id: fixture.observed.workflowId, spend: expect.objectContaining({ billableMinor: "1000", currency: "INR", runCount: 1 }) }));
      expect(snapshot.recentRuns).toEqual([expect.objectContaining({ id: fixture.observed.runId, workflow_id: fixture.observed.workflowId, status: "failed" })]);
      expect(snapshot.runDetails).toEqual([expect.objectContaining({ run_cost_minor: "1000", node_executions: [expect.objectContaining({ id: fixture.observed.nodeId, status: "failed", node_cost_minor: "1000", error: expect.stringContaining("TOOL_CALL_VALIDATION_FAILED") })], verification_results: [expect.objectContaining({ gate_type: "mechanical", verdict: "fail" })] })]);
      for (const id of [fixture.observed.foreignWorkflowId, fixture.observed.foreignRunId, fixture.observed.oldRunId]) expect(payload.messages[1].content).not.toContain(id);
      expect(payload.messages[1].content).not.toContain("internal_cost_minor");
      return { outputJson: JSON.stringify({ message: { role: "assistant", content: "The recorded invoice run failed its mechanical check. Its billed spend is ₹10.00 INR. No workflow was changed." }, stop_reason: "end_turn" }),
        usageJson: JSON.stringify({ input_tokens: 10, output_tokens: 5 }), servedBy: "native-model" };
    } });
    const module = await Test.createTestingModule({ imports: [AppModule.register(
      new OperationalConfigProvider(createMockConfigProvider(), undefined, "/native/model-policy"), new FailoverModelProvider(model, {}),
      createMockPIIRedactionProvider(), createMockEmbeddingProvider(), createMockCacheProvider(),
      createMockQueueProvider({ publish: async (_queue, message) => { expect(await client.ingestCostEvent(message as unknown as CostIngestCostEventRequest)).toEqual({ accepted: true }); } }),
      "native-cost-events", "native-admin-fixture", client,
    )] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter()); await app.init();
    const port = await new Promise<number>((done, reject) => { const server = createServer(); server.on("error", reject); server.listen(0, "127.0.0.1", () => {
      const address = server.address(); if (!address || typeof address === "string") return reject(Error("Missing Model Gateway port")); server.close(error => error ? reject(error) : done(address.port));
    }); });
    const address = `127.0.0.1:${port}`;
    await startModelgwGrpcTransport(app, { bindAddress: address, protoPath: resolve("packages/contracts/proto/alter/modelgw/v1/modelgw.proto") });
    expect((await fetch(fixture.controlUrl, { method: "POST", headers: { authorization: `Bearer ${fixture.registryToken}`, "content-type": "application/json" }, body: JSON.stringify({ address }) })).status).toBe(200);
    const publicReportPath = join(fixture.directory, "public-report.json");
    await promisify(execFile)(process.execPath, [resolve("node_modules/vitest/vitest.mjs"), "run", "--config", "apps/platform-api/vitest.config.ts", "apps/platform-api/src/workflow-chat/platform-workflow-chat-assistant.integration.spec.ts", "--maxWorkers=1", "--reporter=json", `--outputFile=${publicReportPath}`], {
      env: { ...process.env, WORKFLOW_CHAT_NATIVE_PUBLIC_ASSISTANT: JSON.stringify({ ...fixture, costBaseUrl: cost.baseUrl }) }, timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    }).catch(error => { const report = JSON.parse(readFileSync(publicReportPath, "utf8")) as { testResults: { message?: string; assertionResults: { failureMessages: string[] }[] }[] }; throw Error(report.testResults.flatMap(file => [file.message ?? "", ...file.assertionResults.flatMap(test => test.failureMessages)]).join("\n"), { cause: error }); });
    const publicReport = JSON.parse(readFileSync(publicReportPath, "utf8")) as { success: boolean; numPendingTests: number; testResults: { assertionResults: { title: string; status: string }[] }[] };
    expect(publicReport.success).toBe(true); expect(publicReport.numPendingTests).toBe(0);
    const native = publicReport.testResults.flatMap(file => file.assertionResults).filter(test => test.title === "grounds the public assistant in actual readable runs, verification and billed cost with draft-only action");
    expect(native).toHaveLength(1); expect(native[0]!.status).toBe("passed");
    const turn = JSON.parse(readFileSync(join(fixture.directory, "public-assistant-result.json"), "utf8")) as { userMessage: { id: string } };
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tenantId: `ten_${fixture.tenant}`, runId: `run_${turn.userMessage.id.slice(4)}`, nodeExecutionId: `node_${turn.userMessage.id.slice(4)}` });
    const anonymous = new ModelGatewayClient({ address, protoPath: resolve("packages/contracts/proto/alter/modelgw/v1/modelgw.proto") });
    await expect(anonymous.invoke({ tenant_id: `ten_${fixture.tenant}`, run_id: `run_${turn.userMessage.id.slice(4)}`, node_execution_id: `node_${turn.userMessage.id.slice(4)}`, model_alias: "STANDARD", input_json: "{}" })).rejects.toThrow();
    expect(calls).toHaveLength(1);
    writeFileSync(join(fixture.directory, "cost-stop"), "finished");
    const failure = await costResult;
    if (failure) {
      throw Error(costFailure());
    }
    const events = JSON.parse(readFileSync(join(fixture.directory, "cost-persisted.json"), "utf8"));
    expect(events[0]).toMatchObject({ run_id: turn.userMessage.id.slice(4), node_execution_id: turn.userMessage.id.slice(4), workspace_id: fixture.workspace });
  } finally { writeFileSync(join(fixture.directory, "cost-stop"), "finished"); await costResult; await app?.close(); }
}, 120000);
