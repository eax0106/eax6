import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { PostgresCostStoreProvider } from "@alterx/adapters";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMargin } from "../rollup/cost-rollup.service";
import { RunEstimateValidationError, RunEstimatesService } from "./run-estimates.service";

const migrationsFolder = resolve(process.cwd(), "apps/cost-ledger-service/drizzle");
const TENANT_BARE = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const TENANT = `ten_${TENANT_BARE}`;
const WORKSPACE_BARE = "018f4d6e-2b4a-7a3e-8c1a-1234567890c1";
const WORKSPACE = `ws_${WORKSPACE_BARE}`;
const runBare = (n: number) => `018f4d6e-2b4a-7a3e-8c1a-${String(n).padStart(12, "0")}`;
const run = (n: number) => `run_${runBare(n)}`;

// D4 (design log section 9), on a real cost_db: the worst-case bound and the recent-runs average.
describe.sequential("RunEstimatesService", () => {
  let postgres: StartedPostgreSqlContainer;
  let store: PostgresCostStoreProvider;
  // 20% margin, 83 rupees to the dollar, the deployed placeholders.
  const service = () => new RunEstimatesService(store, (minor) => applyMargin(minor, 0.2), "83");

  const price = (provider: string, modelId: string, resource: string, unitCostMinor: string, currency: string) =>
    store.withProvisioner((tx) =>
      tx.query(
        "INSERT INTO model_pricing (provider, model_id, resource, unit_cost_minor, currency) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [provider, modelId, resource, unitCostMinor, currency],
      ),
    );
  const cost = (runNumber: number, internalMinor: number) =>
    store.withTenant(TENANT_BARE, (tx) =>
      tx.query(
        `INSERT INTO cost_events
           (id, tenant_id, workspace_id, mode, source, provider, resource, quantity, unit, internal_cost_minor, occurred_at, run_id)
         VALUES (gen_random_uuid(), $1, $2, 'workflow', 'model_gateway', 'aws-bedrock', 'tokens', 1, 'tokens', $3, now(), $4)`,
        [TENANT_BARE, WORKSPACE_BARE, internalMinor, runBare(runNumber)],
      ),
    );

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:16.6-alpine")
      .withDatabase("cost_db")
      .withUsername("cost_admin")
      .withPassword(randomBytes(24).toString("hex"))
      .start();
    store = new PostgresCostStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
    await store.migrate();
    await price("aws-bedrock", "model-cheap", "input_tokens", "0.001", "USD");
    await price("aws-bedrock", "model-cheap", "output_tokens", "0.004", "USD");
    await price("openai", "model-fallback", "output_tokens", "0.5", "INR");
  }, 120_000);

  afterAll(async () => {
    await store?.close();
    await postgres?.stop();
  }, 60_000);

  it("prices a call at its dearest direction, in rupees, multiplying before it rounds", async () => {
    // 10,000 tokens at 0.004 US cents (the output direction) x 83 = 3,320 paise; +20% margin, once, = 4,150
    const result = await service().worstCase({
      tenantId: TENANT,
      lines: [{ models: [{ provider: "aws-bedrock", modelId: "model-cheap" }], maxTokens: "10000" }],
    });
    expect(result).toEqual({ internalMinor: "3320", billableMinor: "4150", unpricedLines: "0" });
  });

  it("takes the dearest model that could serve the call, fallbacks included", async () => {
    const result = await service().worstCase({
      tenantId: TENANT,
      lines: [
        { models: [{ provider: "aws-bedrock", modelId: "model-cheap" }, { provider: "openai", modelId: "model-fallback" }], maxTokens: "1000" },
      ],
    });
    // the INR fallback at 0.5 paise a token beats the dollar model: 500 paise
    expect(result.internalMinor).toBe("500");
  });

  it("rounds the whole bound up once, not each call", async () => {
    // two calls of 0.4 paise each: 0.8 -> 1, not 1 + 1
    await price("aws-bedrock", "model-tiny", "output_tokens", "0.0004", "INR");
    const result = await service().worstCase({
      tenantId: TENANT,
      lines: [
        { models: [{ provider: "aws-bedrock", modelId: "model-tiny" }], maxTokens: "1000" },
        { models: [{ provider: "aws-bedrock", modelId: "model-tiny" }], maxTokens: "1000" },
      ],
    });
    expect(result.internalMinor).toBe("1");
  });

  it("counts a call with no price on record, and adds nothing for it", async () => {
    const result = await service().worstCase({
      tenantId: TENANT,
      lines: [{ models: [{ provider: "nobody", modelId: "unknown" }], maxTokens: "1000" }],
    });
    expect(result).toEqual({ internalMinor: "0", billableMinor: "0", unpricedLines: "1" });
  });

  it.each([
    [{ tenantId: TENANT, lines: [] }, "lines must list"],
    [{ tenantId: "x", lines: [{}] }, "tenantId must have prefix"],
    [{ tenantId: TENANT, lines: [{ models: [], maxTokens: "1" }] }, "the models that could serve"],
    [{ tenantId: TENANT, lines: [{ models: [{ provider: "p", modelId: "m" }], maxTokens: 5 }] }, "maxTokens must be a whole number"],
    [{ tenantId: TENANT, lines: [{ models: [{ provider: "p", modelId: "m" }], maxTokens: "1.5" }] }, "maxTokens must be a whole number"],
  ])("refuses a malformed request before reading (%#)", async (input, message) => {
    await expect(service().worstCase(input)).rejects.toThrow(message);
    await expect(service().worstCase(input)).rejects.toBeInstanceOf(RunEstimateValidationError);
  });

  it("averages what the given runs were billed, each on its own total, rounded up", async () => {
    await cost(1, 100); // billed 125
    await cost(2, 50);
    await cost(2, 51); // run 2 totals 101, billed ceil(101/0.8) = 127
    await cost(3, 10); // billed 13
    const average = await service().runsAverage({ tenantId: TENANT, workspaceId: WORKSPACE, runIds: [run(1), run(2), run(3), run(4)] });
    // run 4 has no cost data and does not count: (125 + 127 + 13) / 3 = 88.33 -> 89
    expect(average).toEqual({ averageBillableMinor: "89", runCount: "3" });
  });

  it("says nothing when none of the runs has cost data, and never reads another tenant's runs", async () => {
    await expect(service().runsAverage({ tenantId: TENANT, workspaceId: WORKSPACE, runIds: [run(9)] })).resolves.toEqual({ averageBillableMinor: null, runCount: "0" });
    await expect(
      service().runsAverage({ tenantId: `ten_018f4d6e-2b4a-7a3e-8c1a-1234567890b1`, workspaceId: WORKSPACE, runIds: [run(1)] }),
    ).resolves.toEqual({ averageBillableMinor: null, runCount: "0" });
  });

  it("refuses a bad run list", async () => {
    await expect(service().runsAverage({ tenantId: TENANT, workspaceId: WORKSPACE, runIds: [] })).rejects.toThrow("runIds must list");
    await expect(service().runsAverage({ tenantId: TENANT, workspaceId: WORKSPACE, runIds: ["run_nope"] })).rejects.toThrow("runIds must be a run_ prefixed UUID");
  });
});
