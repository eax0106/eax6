import { describe, expect, it, vi } from "vitest";
import {
  createMockCacheProvider, createMockConfigProvider, createMockEmbeddingProvider,
  createMockModelProvider, createMockPIIRedactionProvider, createMockQueueProvider,
} from "@alterx/shared-clients";
import { ModelGatewayService } from "./model-gateway.service";
import { LocalSmokeBudget, localSmokePermitted } from "./local-smoke-budget";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("local smoke pre-call guard", () => {
  it("arms a real private permit only for the recorded process, tenant and run", () => {
    const directory = mkdtempSync(join(tmpdir(), "alter-smoke-permit-")), file = join(directory, "permit.json");
    try {
      expect(localSmokePermitted(file, "tenant", "run_real")).toBe(false);
      writeFileSync(file, "invalid", { mode: 0o600 });
      expect(localSmokePermitted(file, "tenant", "run_real")).toBe(false);
      for (const change of [{}, { gatewayPid: -1 }, { tenantId: "other" }, { runId: "run_other" }, { runId: "" }]) {
        writeFileSync(file, JSON.stringify({ gatewayPid: process.pid, tenantId: "tenant", runId: "run_real", ...change }));
        expect(localSmokePermitted(file, "tenant", "run_real")).toBe(Object.keys(change).length === 0);
      }
      writeFileSync(file, JSON.stringify({ gatewayPid: process.pid, tenantId: "tenant", runId: "run_real" }));
      expect(localSmokePermitted(file, "tenant")).toBe(true); // Embed has tenant context, no run field.
      rmSync(file);
      expect(localSmokePermitted(file, "tenant", "run_real")).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("caps requested output and refuses unknown prices, fallbacks and exhausted shared budget", () => {
    const budget = new LocalSmokeBudget(() => true);
    const json = JSON.stringify({ messages: [{ role: "user", content: "hello" }], max_tokens: 5000 });
    const capped = budget.prepareInput(json);
    expect(JSON.parse(capped).max_tokens).toBe(1024);
    expect(JSON.parse(budget.prepareInput(json.replace("5000", "100"))).max_tokens).toBe(100);
    expect(() => budget.prepareInput("{}" )).toThrow();
    expect(() => budget.reserveModel("unpriced", capped)).toThrow("unpriced");
    expect(() => budget.reserveModel("apac.amazon.nova-pro-v1:0", capped, [{}])).toThrow("fallback");
    expect(() => budget.reserveModel("apac.amazon.nova-pro-v1:0", json)).toThrow("cap missing");
    // One embedding can reserve ~$0.225. Three short Pro calls fit; a fourth
    // exceeds $0.25. Both types debit the same allowance before dispatch.
    budget.reserveEmbedding("x".repeat(1_500_000));
    for (let i = 0; i < 3; i++) budget.reserveModel("apac.amazon.nova-pro-v1:0", capped);
    expect(() => budget.reserveModel("apac.amazon.nova-pro-v1:0", capped)).toThrow("exhausted");
    expect(() => budget.reserveEmbedding("x".repeat(100_000))).toThrow("exhausted");
    expect(() => new LocalSmokeBudget(() => true).reserveEmbedding("x".repeat(2_000_000))).toThrow("exhausted");
    expect(() => new LocalSmokeBudget().reserveEmbedding("hello")).toThrow("not armed");
    let permitted = false;
    const switched = new LocalSmokeBudget(() => permitted);
    expect(() => switched.reserveModel("apac.amazon.nova-pro-v1:0", capped)).toThrow("not armed");
    permitted = true; switched.reserveModel("apac.amazon.nova-pro-v1:0", capped);
    permitted = false;
    expect(() => switched.reserveModel("apac.amazon.nova-pro-v1:0", capped)).toThrow("not armed");
  });
  it("refuses invoke, stream and embedding before touching any paid provider", async () => {
    const invoke = vi.fn(createMockModelProvider().invoke);
    const stream = vi.fn(createMockModelProvider().stream);
    const embed = vi.fn(createMockEmbeddingProvider().embed);
    const deny = () => { throw new Error("Local smoke budget exhausted"); };
    const service = new ModelGatewayService(
      createMockConfigProvider(), createMockModelProvider({ invoke, stream }),
      createMockPIIRedactionProvider(), createMockEmbeddingProvider({ embed }),
      createMockCacheProvider(), createMockQueueProvider(), "cost-events",
      { ingestCostEvent: async () => ({ accepted: true }),
        resolveUnitPrice: async () => ({ unit_cost_minor: "0", currency: "INR", confidence: "no_data" }),
        recordModelOutcome: async () => ({ accepted: true }) },
      // Structural stub exercises the production dispatch paths, without AWS.
      { prepareInput: (input: string) => input, reserveModel: deny, reserveEmbedding: deny },
    );
    const request = { tenant_id: "local", run_id: "local", node_execution_id: "local",
      model_alias: "STANDARD", input_json: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }) };
    await expect(service.invoke(request)).rejects.toThrow("Local smoke budget exhausted");
    await expect((async () => { for await (const chunk of service.stream(request)) void chunk; })()).rejects.toThrow("Local smoke budget exhausted");
    await expect(service.embed({ tenant_id: "local", text: "hello", dimensions: 512 })).rejects.toThrow("Local smoke budget exhausted");
    expect(invoke).not.toHaveBeenCalled(); expect(stream).not.toHaveBeenCalled(); expect(embed).not.toHaveBeenCalled();
  });
});
