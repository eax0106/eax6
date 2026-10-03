import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { EscalationsController } from "./escalations.controller";
import {
  EscalationNotFoundError,
  EscalationsService,
  EscalationStateConflictError,
  EscalationValidationError,
} from "./escalations.service";

const TENANT = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const ESCALATION = "esc_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const RUN = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const NODE_EXECUTION = "node_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const RECOVERY_ACTION = "rec_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const USER_ID = "usr_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";

function escalations(): EscalationsService {
  return {
    create: vi.fn(),
    getById: vi.fn(),
    list: vi.fn(),
    claim: vi.fn(),
    resolve: vi.fn(),
  } as unknown as EscalationsService;
}

function escalationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ESCALATION,
    run_id: RUN,
    node_execution_id: NODE_EXECUTION,
    recovery_action_id: RECOVERY_ACTION,
    reason: "recovery exhausted",
    status: "open",
    claimed_by: null,
    claimed_at: null,
    resolved_by: null,
    resolved_at: null,
    resolution_note: null,
    created_at: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

function request(tenantId: string | undefined = TENANT, userId: string | null = USER_ID) {
  return {
    actorContext: tenantId === undefined ? undefined : { tenant_id: tenantId, user_id: userId, workspace_id: "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890ac" },
    url: "/api/v1/escalations",
  };
}

describe("EscalationsController.list/get", () => {
  it("lists escalations tenant-scoped with query filters", async () => {
    const service = escalations();
    vi.mocked(service.list).mockResolvedValue({
      data: [escalationRow()],
      page: { next_cursor: null, has_more: false, limit: 50 },
    });

    const response = await new EscalationsController(service).list(request() as never, {
      status: "open",
    });

    expect(service.list).toHaveBeenCalledWith(TENANT, { status: "open", workspaceId: "018f4d6e-2b4a-7a3e-8c1a-1234567890ac" });
    expect(response.data).toHaveLength(1);
  });

  it("maps EscalationNotFoundError to 404 on get", async () => {
    const service = escalations();
    vi.mocked(service.getById).mockRejectedValue(new EscalationNotFoundError(ESCALATION));

    await expect(
      new EscalationsController(service).get(request() as never, ESCALATION),
    ).rejects.toMatchObject({ response: expect.objectContaining({ status: 404 }) });
  });

  it("returns 500 with real ProblemDetails identifiers when tenant context is missing", async () => {
    await expect(
      new EscalationsController(escalations()).get(request(undefined) as never, ESCALATION),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        status: 500,
        trace_id: expect.stringMatching(/^trc_[0-9a-f-]+$/i),
        request_id: expect.stringMatching(/^req_[0-9a-f-]+$/i),
      }),
    });
  });
});

describe("EscalationsController.claim/resolve", () => {
  it("claims and strips the usr_ prefix from claimed_by", async () => {
    const service = escalations();
    vi.mocked(service.claim).mockResolvedValue(escalationRow({ status: "claimed" }));

    const response = await new EscalationsController(service).claim(
      request() as never,
      ESCALATION,
    );

    expect(service.claim).toHaveBeenCalledWith(
      TENANT,
      ESCALATION,
      "018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
    );
    expect(response).toMatchObject({ status: "claimed" });
  });

  it("resolves with a real note", async () => {
    const service = escalations();
    vi.mocked(service.resolve).mockResolvedValue(escalationRow({ status: "resolved" }));

    await new EscalationsController(service).resolve(request() as never, ESCALATION, {
      note: "handled manually",
    });

    expect(service.resolve).toHaveBeenCalledWith(
      TENANT,
      ESCALATION,
      "018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
      "handled manually",
    );
  });

  it("passes undefined actor id for a service actor with no user_id", async () => {
    const service = escalations();
    vi.mocked(service.claim).mockResolvedValue(escalationRow({ status: "claimed" }));

    await new EscalationsController(service).claim(request(TENANT, null) as never, ESCALATION);

    expect(service.claim).toHaveBeenCalledWith(TENANT, ESCALATION, undefined);
  });

  it("maps EscalationStateConflictError to 409", async () => {
    const service = escalations();
    vi.mocked(service.claim).mockRejectedValue(
      new EscalationStateConflictError("already claimed"),
    );

    await expect(
      new EscalationsController(service).claim(request() as never, ESCALATION),
    ).rejects.toMatchObject({ response: expect.objectContaining({ status: 409 }) });
  });

  it("maps EscalationValidationError to 400", async () => {
    const service = escalations();
    vi.mocked(service.claim).mockRejectedValue(new EscalationValidationError("bad id"));

    await expect(
      new EscalationsController(service).claim(request() as never, ESCALATION),
    ).rejects.toMatchObject({ response: expect.objectContaining({ status: 400 }) });
  });

  it("maps an unknown error to 500", async () => {
    const service = escalations();
    vi.mocked(service.claim).mockRejectedValue(new Error("unexpected"));

    await expect(
      new EscalationsController(service).claim(request() as never, ESCALATION),
    ).rejects.toBeInstanceOf(HttpException);
  });
});
