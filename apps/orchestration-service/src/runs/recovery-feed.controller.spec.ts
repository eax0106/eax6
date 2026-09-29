import { HttpException } from "@nestjs/common";
import type { ActorContext } from "@alterx/auth";
import { describe, expect, it, vi } from "vitest";
import { RecoveryFeedController } from "./recovery-feed.controller";
import {
  RunObservabilityValidationError,
  type RunObservabilityService,
} from "./run-observability.service";

const TENANT = "ten_018f4d6e-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const actor = (over: Partial<ActorContext>): ActorContext => ({
  actor_type: "system",
  user_id: null,
  tenant_id: TENANT,
  workspace_id: null,
  roles: ["system:platform-jobs"],
  permissions: ["runs:read"],
  session_id: null,
  jti: "j",
  ...over,
});

function setup(result: unknown = { data: [], page: { next_cursor: null, has_more: false, limit: 50 } }) {
  const recentResolvedRecoveries = vi.fn().mockImplementation(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  const controller = new RecoveryFeedController({ recentResolvedRecoveries } as unknown as RunObservabilityService);
  return { controller, recentResolvedRecoveries };
}

const req = (a?: ActorContext) => ({
  headers: {},
  url: "/api/v1/recovery-actions",
  ...(a === undefined ? {} : { actorContext: a }),
});

describe("RecoveryFeedController", () => {
  it("answers the system principal for its own tenant, passing the query through", async () => {
    const { controller, recentResolvedRecoveries } = setup();
    await controller.list(req(actor({})), { resolved_after: "2026-09-29T09:00:00.000Z", cursor: "rec_1", limit: "10" });
    expect(recentResolvedRecoveries).toHaveBeenCalledWith(TENANT, {
      resolvedAfter: "2026-09-29T09:00:00.000Z",
      cursor: "rec_1",
      limit: 10,
    });
  });

  it.each([
    ["a user", actor({ actor_type: "user", user_id: "usr_1", workspace_id: "ws_1" })],
    ["a service", actor({ actor_type: "service" })],
  ])("refuses %s with 403 and reads nothing", async (_name, who) => {
    const { controller, recentResolvedRecoveries } = setup();
    const error = await controller.list(req(who), {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(403);
    expect((error as HttpException).getResponse()).toMatchObject({ error_code: "RECOVERY_FEED_SYSTEM_ONLY" });
    expect(recentResolvedRecoveries).not.toHaveBeenCalled();
  });

  it("answers 500 when there is no authenticated actor at all", async () => {
    const { controller } = setup();
    await expect(controller.list(req(undefined), {})).rejects.toMatchObject({ status: 500 });
  });

  it("maps a validation failure to 400 and anything else to 500", async () => {
    await expect(
      setup(new RunObservabilityValidationError("limit must be an integer from 1 to 200")).controller.list(req(actor({})), {}),
    ).rejects.toMatchObject({ status: 400 });
    await expect(setup(new Error("db down")).controller.list(req(actor({})), {})).rejects.toMatchObject({ status: 500 });
  });
});
