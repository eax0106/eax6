import { describe, expect, it, vi } from "vitest";

import { createMockAuditEventHandler } from "@alterx/shared-clients";

import {
  RunOutcomeNotCompletedError,
  RunOutcomeRunNotFoundError,
  RunOutcomeService,
  RunOutcomeTenantMismatchError,
} from "./run-outcome.service";
import { RunLearningController } from "./run-learning.controller";

const TENANT = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const RUN = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890ad";

function service(): RunOutcomeService {
  return { getLearningSummary: vi.fn() } as unknown as RunOutcomeService;
}

function request(
  tenantId: string | null = TENANT,
  actorType: "user" | "service" = "user",
) {
  return {
    actorContext:
      tenantId === null ? undefined : { tenant_id: tenantId, actor_type: actorType },
    url: `/internal/runs/${RUN}/outcome-summary`,
  };
}

const OTHER_TENANT = "ten_018f4d6e-2b4a-7a3e-8c1a-99999999ffff";

describe("RunLearningController", () => {
  it("uses authenticated tenant context and returns the minimal summary", async () => {
    const outcomes = service();
    vi.mocked(outcomes.getLearningSummary).mockResolvedValue({
      tenant_id: TENANT,
      run_id: RUN,
      workspace_id: "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890ac",
      verdict: "failed",
      gates_passed: 1,
      gates_failed: 1,
      recovery_count: 1,
      nodes: [],
      recovery_actions: [],
    });

    const result = await new RunLearningController(outcomes, createMockAuditEventHandler()).summary(
      request() as never,
      RUN,
    );
    expect(result.verdict).toBe("failed");
    expect(outcomes.getLearningSummary).toHaveBeenCalledWith(TENANT, RUN, { assertedByService: false });
  });

  it.each([
    [new RunOutcomeRunNotFoundError(RUN), 404],
    [new RunOutcomeNotCompletedError(RUN), 409],
  ] as const)("maps typed errors to HTTP %s", async (error, expectedStatus) => {
    const outcomes = service();
    vi.mocked(outcomes.getLearningSummary).mockRejectedValue(error);
    await expect(
      new RunLearningController(outcomes, createMockAuditEventHandler()).summary(request() as never, RUN),
    ).rejects.toMatchObject({
      status: expectedStatus,
      response: expect.objectContaining({
        status: expectedStatus,
        trace_id: expect.stringMatching(/^trc_[0-9a-f-]+$/i),
        request_id: expect.stringMatching(/^req_[0-9a-f-]+$/i),
      }),
    });
  });

  it("fails closed when authenticated tenant context is missing", async () => {
    await expect(
      new RunLearningController(service(), createMockAuditEventHandler()).summary(request(null) as never, RUN),
    ).rejects.toMatchObject({ status: 500 });
  });
});

describe("RunLearningController tenant_id parameter", () => {
  it("lets a service caller name the tenant it is reading for", async () => {
    // memory-service calls under its own machine identity, so the tenant in
    // its token is memory-service's rather than the run's. Without this it
    // could only ever read runs belonging to its service identity.
    const outcomes = service();
    vi.mocked(outcomes.getLearningSummary).mockResolvedValue({} as never);

    await new RunLearningController(outcomes, createMockAuditEventHandler()).summary(
      request(TENANT, "service") as never,
      RUN,
      OTHER_TENANT,
    );

    expect(outcomes.getLearningSummary).toHaveBeenCalledWith(OTHER_TENANT, RUN, { assertedByService: true });
  });

  it("ignores the parameter for a user caller", async () => {
    // This route is behind SessionGatewayGuard, which authenticates user
    // session tokens too. Honouring the parameter for one would be a
    // cross-tenant read.
    const outcomes = service();
    vi.mocked(outcomes.getLearningSummary).mockResolvedValue({} as never);

    await new RunLearningController(outcomes, createMockAuditEventHandler()).summary(
      request(TENANT, "user") as never,
      RUN,
      OTHER_TENANT,
    );

    expect(outcomes.getLearningSummary).toHaveBeenCalledWith(TENANT, RUN, { assertedByService: false });
  });

  it("falls back to the token tenant when a service caller omits it", async () => {
    const outcomes = service();
    vi.mocked(outcomes.getLearningSummary).mockResolvedValue({} as never);

    await new RunLearningController(outcomes, createMockAuditEventHandler()).summary(
      request(TENANT, "service") as never,
      RUN,
    );

    expect(outcomes.getLearningSummary).toHaveBeenCalledWith(TENANT, RUN, { assertedByService: false });
  });
});

describe("RunLearningController service-asserted tenants (design log §30)", () => {
  it("refuses a tenant the run does not belong to by name, not as not-found, and audits it", async () => {
    const outcomes = service();
    vi.mocked(outcomes.getLearningSummary).mockRejectedValue(new RunOutcomeTenantMismatchError(RUN));
    const audit = createMockAuditEventHandler();
    const recordEvent = vi.spyOn(audit, "recordEvent");

    await expect(
      new RunLearningController(outcomes, audit).summary(
        request(TENANT, "service") as never,
        RUN,
        OTHER_TENANT,
      ),
    ).rejects.toMatchObject({
      status: 403,
      response: expect.objectContaining({ error_code: "SERVICE_TENANT_MISMATCH" }),
    });
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: OTHER_TENANT,
        actor_type: "service",
        actor_ref: `service:${TENANT}`,
        action: "run.outcome_summary.read",
        target_type: "run",
        target_ref: RUN,
        result: "denied",
      }),
    );
  });

  it("audits every successful service-asserted read", async () => {
    const outcomes = service();
    vi.mocked(outcomes.getLearningSummary).mockResolvedValue({} as never);
    const audit = createMockAuditEventHandler();
    const recordEvent = vi.spyOn(audit, "recordEvent");

    await new RunLearningController(outcomes, audit).summary(
      request(TENANT, "service") as never,
      RUN,
      OTHER_TENANT,
    );

    expect(recordEvent).toHaveBeenCalledOnce();
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: OTHER_TENANT, result: "success" }),
    );
  });

  it("does not audit a caller reading its own token tenant", async () => {
    const outcomes = service();
    vi.mocked(outcomes.getLearningSummary).mockResolvedValue({} as never);
    const audit = createMockAuditEventHandler();
    const recordEvent = vi.spyOn(audit, "recordEvent");

    await new RunLearningController(outcomes, audit).summary(request(TENANT, "user") as never, RUN, OTHER_TENANT);

    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("still answers when the audit write fails", async () => {
    const outcomes = service();
    vi.mocked(outcomes.getLearningSummary).mockResolvedValue({ verdict: "passed" } as never);
    const audit = createMockAuditEventHandler();
    vi.spyOn(audit, "recordEvent").mockRejectedValue(new Error("audit-service down"));

    const result = await new RunLearningController(outcomes, audit).summary(
      request(TENANT, "service") as never,
      RUN,
      OTHER_TENANT,
    );

    expect(result).toEqual({ verdict: "passed" });
  });
});
