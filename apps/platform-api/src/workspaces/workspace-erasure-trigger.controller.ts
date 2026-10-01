import { createHash, timingSafeEqual } from "node:crypto";
import { Controller, Headers, HttpCode, HttpException, Inject, Post } from "@nestjs/common";
import { Public } from "../rbac/decorators";
import { NOTIFICATION_DIGEST_SERVICE_TOKEN_HASH } from "../notifications/notification-digest-scheduler.controller";
import { WorkspaceErasureRunner } from "./workspace-erasure.runner";

/**
 * The trigger for the workspace erasure sweep (D2, C82). Internal only,
 * authenticated with the same Platform Jobs shared secret as the other
 * sweeps; `@Public()` bypasses per-actor RBAC because there is no user here.
 * Listed in system-caller.spec.ts as a trigger controller.
 */
@Controller("internal/workspace-deletions")
export class WorkspaceErasureTriggerController {
  constructor(
    private readonly runner: WorkspaceErasureRunner,
    @Inject(NOTIFICATION_DIGEST_SERVICE_TOKEN_HASH) private readonly tokenHash: string,
  ) {}

  @Public()
  @Post("process-due")
  @HttpCode(200)
  async processDue(@Headers("authorization") auth?: string) {
    this.authorize(auth);
    const result = await this.runner.run();
    return {
      tenants: result.tenants,
      tenants_failed: result.tenantsFailed,
      workspaces_erased: result.workspacesErased,
      workspaces_failed: result.workspacesFailed,
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
          instance: "/internal/workspace-deletions/process-due",
        },
        401,
      );
    }
  }
}
