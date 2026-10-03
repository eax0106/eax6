import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import {
  RunLauncherService,
  RunNotFoundError,
  RunStartFailedError,
  RunStateConflictError,
  RunValidationError,
  WorkflowNotFoundError,
} from "./run-launcher.service";
import { BudgetExceededError } from "../budgets/budget.service";
import { RunEstimateService } from "../budgets/run-estimate.service";
import { RunOutcomeService } from "./run-outcome.service";
import { RunsController } from "./runs.controller";

const TENANT = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const WORKSPACE = "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890ac";
const RUN = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const WORKFLOW = "wf_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";

function launcher(): RunLauncherService {
  return {
    createRun: vi.fn(),
    listRuns: vi.fn(),
    getRun: vi.fn(),
    cancelRun: vi.fn(),
    retryNode: vi.fn(),
  } as unknown as RunLauncherService;
}

function outcomes(): RunOutcomeService {
  return {
    getByRunId: vi.fn(),
  } as unknown as RunOutcomeService;
}

function estimates(): RunEstimateService {
  return { estimate: vi.fn() } as unknown as RunEstimateService;
}

function request(tenantId: string | undefined = TENANT) {
  return { actorContext: tenantId === undefined ? undefined : { tenant_id: tenantId, workspace_id: WORKSPACE }, url: `/api/v1/runs` };
}

function runRow(status = "pending") {
  return {
    id: RUN,
    workflow_id: WORKFLOW,
    workflow_version_id: null,
    parent_kind: "workflow",
    status,
    started_at: null,
    ended_at: null,
    created_at: "2026-07-28T00:00:00.000Z",
  };
}

function fakeReply() {
  return { header: vi.fn() };
}

describe("RunsController.create", () => {
  it("creates a run and sets the Location header", async () => {
    const service = launcher();
    vi.mocked(service.createRun).mockResolvedValue(runRow());
    const reply = fakeReply();

    const response = await new RunsController(service, outcomes(), estimates()).create(
      request() as never,
      reply as never,
      { workflow_id: WORKFLOW },
    );

    expect(service.createRun).toHaveBeenCalledWith(
      TENANT,
      WORKFLOW,
      undefined,
      undefined,
      {},
    );
    expect(reply.header).toHaveBeenCalledWith("location", `/api/v1/runs/${RUN}`);
    expect(response).toMatchObject({ id: RUN, status: "pending" });
  });

  it("forwards a requested run timeout", async () => {
    const service = launcher();
    vi.mocked(service.createRun).mockResolvedValue(runRow());

    await new RunsController(service, outcomes(), estimates()).create(
      request() as never,
      fakeReply() as never,
      { workflow_id: WORKFLOW, timeout_ms: 5_000 },
    );

    expect(service.createRun).toHaveBeenCalledWith(
      TENANT,
      WORKFLOW,
      undefined,
      undefined,
      { timeoutMs: 5_000 },
    );
  });

  it("rejects a missing workflow_id with a 400 ProblemDetails", async () => {
    const service = launcher();
    await expect(
      new RunsController(service, outcomes(), estimates()).create(request() as never, fakeReply() as never, {} as never),
    ).rejects.toMatchObject({ response: expect.objectContaining({ status: 400 }) });
    expect(service.createRun).not.toHaveBeenCalled();
  });

  it("maps WorkflowNotFoundError to 404", async () => {
    const service = launcher();
    vi.mocked(service.createRun).mockRejectedValue(new WorkflowNotFoundError(WORKFLOW));

    await expect(
      new RunsController(service, outcomes(), estimates()).create(request() as never, fakeReply() as never, {
        workflow_id: WORKFLOW,
      }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ status: 404 }) });
  });

  it("maps RunStartFailedError to 502", async () => {
    const service = launcher();
    vi.mocked(service.createRun).mockRejectedValue(new RunStartFailedError(RUN, new Error("x")));

    await expect(
      new RunsController(service, outcomes(), estimates()).create(request() as never, fakeReply() as never, {
        workflow_id: WORKFLOW,
      }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ status: 502 }) });
  });

  it("maps RunValidationError to 400", async () => {
    const service = launcher();
    vi.mocked(service.createRun).mockRejectedValue(new RunValidationError("no promoted version"));

    await expect(
      new RunsController(service, outcomes(), estimates()).create(request() as never, fakeReply() as never, {
        workflow_id: WORKFLOW,
      }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ status: 400 }) });
  });

  it("returns 500 with real ProblemDetails identifiers when tenant context is missing", async () => {
    await expect(
      new RunsController(launcher(), outcomes(), estimates()).create(
        request(undefined) as never,
        fakeReply() as never,
        { workflow_id: WORKFLOW },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        status: 500,
        trace_id: expect.stringMatching(/^trc_[0-9a-f-]+$/i),
        request_id: expect.stringMatching(/^req_[0-9a-f-]+$/i),
      }),
    });
  });
});

describe("RunsController.list/get", () => {
  it("lists runs tenant-scoped with query filters", async () => {
    const service = launcher();
    vi.mocked(service.listRuns).mockResolvedValue({
      data: [runRow("running")],
      page: { next_cursor: null, has_more: false, limit: 50 },
    });

    const response = await new RunsController(service, outcomes(), estimates()).list(request() as never, {
      workflow_id: WORKFLOW,
      status: "running",
    });

    expect(service.listRuns).toHaveBeenCalledWith(TENANT, {
      workflowId: WORKFLOW,
      status: "running",
      workspaceId: WORKSPACE.slice(3),
    });
    expect(response.data).toHaveLength(1);
  });

  it("maps RunNotFoundError to 404 on get", async () => {
    const service = launcher();
    vi.mocked(service.getRun).mockRejectedValue(new RunNotFoundError(RUN));

    await expect(
      new RunsController(service, outcomes(), estimates()).get(request() as never, RUN),
    ).rejects.toMatchObject({ response: expect.objectContaining({ status: 404 }) });
  });
});

describe("RunsController.cancel", () => {
  it("cancels a run", async () => {
    const service = launcher();
    vi.mocked(service.cancelRun).mockResolvedValue(runRow("cancelled"));

    const response = await new RunsController(service, outcomes(), estimates()).cancel(request() as never, RUN);
    expect(response).toMatchObject({ status: "cancelled" });
  });

  // These tests call the method rather than the route, so the status code
  // they answer with is invisible here: both actions answered Nest's POST
  // default of 201 for as long as nothing called them over HTTP, while
  // openapi.json documented 200.
  it.each(["cancel", "retryNode"] as const)(
    "declares %s as 200, the status its contract publishes",
    (method) => {
      expect(Reflect.getMetadata("__httpCode__", RunsController.prototype[method])).toBe(200);
    },
  );
});

describe("RunsController.retryNode", () => {
  it("retries a node and rejects a missing node_key", async () => {
    const service = launcher();
    await expect(
      new RunsController(service, outcomes(), estimates()).retryNode(request() as never, RUN, {} as never),
    ).rejects.toMatchObject({ response: expect.objectContaining({ status: 400 }) });
    expect(service.retryNode).not.toHaveBeenCalled();
  });

  it("maps RunStateConflictError to 409", async () => {
    const service = launcher();
    vi.mocked(service.retryNode).mockRejectedValue(
      new RunStateConflictError("retry-node requires run status failed"),
    );

    await expect(
      new RunsController(service, outcomes(), estimates()).retryNode(request() as never, RUN, { node_key: "node_a" }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ status: 409 }) });
  });

  it("succeeds and returns the running run", async () => {
    const service = launcher();
    vi.mocked(service.retryNode).mockResolvedValue(runRow("running"));

    const response = await new RunsController(service, outcomes(), estimates()).retryNode(request() as never, RUN, {
      node_key: "node_a",
    });
    expect(response).toMatchObject({ status: "running" });
    expect(service.retryNode).toHaveBeenCalledWith(TENANT, RUN, "node_a");
  });
});

describe("RunsController error mapping fallback", () => {
  it("maps an unknown error to 500", async () => {
    const service = launcher();
    vi.mocked(service.getRun).mockRejectedValue(new Error("unexpected"));

    await expect(new RunsController(service, outcomes(), estimates()).get(request() as never, RUN)).rejects.toBeInstanceOf(
      HttpException,
    );
  });
});

describe("RunsController budgets and estimates (D3, D4)", () => {
  it("answers 409 BUDGET_EXCEEDED when a run would go over budget", async () => {
    const service = launcher();
    vi.mocked(service.createRun).mockRejectedValue(new BudgetExceededError("bud_1", "workspace", "100", "100", "10"));
    await expect(
      new RunsController(service, outcomes(), estimates()).create(request() as never, fakeReply() as never, { workflow_id: WORKFLOW }),
    ).rejects.toMatchObject({ status: 409, response: { error_code: "BUDGET_EXCEEDED" } });
  });

  it("returns the pre-run estimate for the caller's tenant", async () => {
    const service = estimates();
    const figure = { currency: "INR", at_most_minor: 500, usually_minor: null, sample_runs: 0, model_calls: 2, unpriced_calls: 0 };
    vi.mocked(service.estimate).mockResolvedValue(figure as never);
    const response = await new RunsController(launcher(), outcomes(), service).estimate(request() as never, { workflow_id: WORKFLOW });
    expect(response).toEqual(figure);
    expect(service.estimate).toHaveBeenCalledWith(TENANT, WORKSPACE, WORKFLOW, undefined);
  });

  it("refuses an estimate with no authenticated workspace", async () => {
    const service = estimates();
    await expect(
      new RunsController(launcher(), outcomes(), service).estimate(
        { actorContext: { tenant_id: TENANT }, url: "/api/v1/runs/estimate" } as never,
        { workflow_id: WORKFLOW },
      ),
    ).rejects.toMatchObject({ status: 500 });
    expect(service.estimate).not.toHaveBeenCalled();
  });

  it("refuses an estimate with no workflow", async () => {
    await expect(
      new RunsController(launcher(), outcomes(), estimates()).estimate(request() as never, {}),
    ).rejects.toMatchObject({ status: 400 });
  });
});
