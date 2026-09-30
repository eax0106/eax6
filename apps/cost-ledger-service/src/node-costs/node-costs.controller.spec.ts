import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeCostsController } from "./node-costs.controller";
import { NodeCostsService, NodeCostValidationError } from "./node-costs.service";
import { RunTotalService } from "./run-total.service";

const TENANT = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const WORKSPACE = "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890a2";
const RUN = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890a3";

describe("NodeCostsController", () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  it("registers the by-run HTTP route and returns real node cost rows", async () => {
    const getForRun = vi.fn().mockResolvedValue([
      {
        nodeExecutionId: "node_018f4d6e-2b4a-7a3e-8c1a-1234567890a4",
        internalCostMinor: "37",
        eventCount: 2,
      },
    ]);
    app = await createApp({ getForRun });

    const response = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: `/costs/by-run/${RUN}?tenantId=${TENANT}&workspaceId=${WORKSPACE}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      node_costs: [
        {
          node_execution_id: "node_018f4d6e-2b4a-7a3e-8c1a-1234567890a4",
          internal_cost_minor: "37",
          event_count: 2,
        },
      ],
    });
    expect(getForRun).toHaveBeenCalledWith({
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      runId: RUN,
    });
  });

  it("returns 400 when the service rejects a malformed run id", async () => {
    app = await createApp({
      getForRun: vi.fn().mockRejectedValue(
        new NodeCostValidationError("runId must be a run_ prefixed UUID"),
      ),
    });

    const response = await app.getHttpAdapter().getInstance().inject({
      method: "GET",
      url: `/costs/by-run/run_invalid?tenantId=${TENANT}&workspaceId=${WORKSPACE}`,
    });

    expect(response.statusCode).toBe(400);
  });
});

async function createApp(nodeCosts: Pick<NodeCostsService, "getForRun">): Promise<INestApplication> {
  const module = await Test.createTestingModule({
    controllers: [NodeCostsController],
    providers: [
      { provide: NodeCostsService, useValue: nodeCosts },
      { provide: RunTotalService, useValue: {} },
    ],
  }).compile();
  const app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
