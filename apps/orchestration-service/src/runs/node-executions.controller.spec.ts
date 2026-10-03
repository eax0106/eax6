import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import {
  NodeExecutionLedgerService,
  NodeExecutionRunNotFoundError,
} from "./node-execution-ledger.service";
import { NodeExecutionsController } from "./node-executions.controller";

const TENANT = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const RUN = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";

function ledger(): NodeExecutionLedgerService {
  return {
    list: vi.fn().mockResolvedValue({
      data: [],
      page: { next_cursor: null, has_more: false, limit: 50 },
    }),
  } as unknown as NodeExecutionLedgerService;
}

function request(tenantId = TENANT) {
  return { actorContext: { tenant_id: tenantId, workspace_id: "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890ac" }, url: `/api/v1/runs/${RUN}/node-executions` };
}

describe("NodeExecutionsController", () => {
  it("returns tenant-scoped ledger page", async () => {
    const store = ledger();
    const response = await new NodeExecutionsController(store).list(
      request() as never,
      RUN,
      { limit: "200" },
    );
    expect(response).toEqual({
      data: [],
      page: { next_cursor: null, has_more: false, limit: 50 },
    });
    expect(store.list).toHaveBeenCalledWith(TENANT, RUN, { limit: 200, workspaceId: "018f4d6e-2b4a-7a3e-8c1a-1234567890ac" });
  });

  it("returns real ProblemDetails identifiers on missing tenant", async () => {
    await expect(
      new NodeExecutionsController(ledger()).list(
        { actorContext: undefined, url: "/api/v1/runs/nope/node-executions" } as never,
        RUN,
        {},
      ),
    ).rejects.toMatchObject({
      status: 500,
      response: expect.objectContaining({
        trace_id: expect.stringMatching(/^trc_[0-9a-f-]+$/i),
        request_id: expect.stringMatching(/^req_[0-9a-f-]+$/i),
      }),
    });
  });

  it("maps a tenant-invisible run to 404 without leaking records", async () => {
    const store = ledger();
    vi.mocked(store.list).mockRejectedValueOnce(new NodeExecutionRunNotFoundError(RUN));
    try {
      await new NodeExecutionsController(store).list(request() as never, RUN, {});
      throw new Error("expected HttpException");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(404);
    }
  });
});
