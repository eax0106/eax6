import { createHash, timingSafeEqual } from "node:crypto";
import { Controller, Headers, HttpException, Inject, Post } from "@nestjs/common";
import { Public } from "../../rbac/decorators";
import { NOTIFICATION_DIGEST_SERVICE_TOKEN_HASH } from "../notification-digest-scheduler.controller";
import { EngineEventNotificationRunner } from "./engine-event-notification.runner";

/**
 * The trigger for the scheduled engine-event pass (D1). Internal only, and
 * authenticated with the same shared secret as the digest trigger: only the
 * Platform Jobs worker holds it. `@Public()` bypasses the per-actor RBAC guard
 * because there is no user here; `authorize` is the boundary in its place.
 */
@Controller("internal/notifications")
export class EngineEventSchedulerController {
  constructor(
    private readonly runner: EngineEventNotificationRunner,
    @Inject(NOTIFICATION_DIGEST_SERVICE_TOKEN_HASH) private readonly tokenHash: string,
  ) {}

  @Public()
  @Post("run-engine-producers")
  async run(@Headers("authorization") auth?: string) {
    this.authorize(auth);
    const result = await this.runner.run();
    return {
      tenants: result.tenants,
      tenants_failed: result.tenantsFailed,
      notifications_created: result.notificationsCreated,
    };
  }

  private authorize(value: string | undefined): void {
    const token = value?.startsWith("Bearer ") ? value.slice(7) : "";
    const actual = createHash("sha256").update(token).digest();
    const expected = Buffer.from(this.tokenHash, "hex");
    if (!token || expected.length !== actual.length || !timingSafeEqual(actual, expected)) {
      throw new HttpException(
        {
          type: "https://alter.dev/problems/unauthorized",
          title: "Unauthorized",
          status: 401,
          instance: "/internal/notifications/run-engine-producers",
        },
        401,
      );
    }
  }
}
