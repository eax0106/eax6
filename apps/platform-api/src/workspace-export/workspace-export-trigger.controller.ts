import { createHash, timingSafeEqual } from "node:crypto";
import { Controller, Headers, HttpCode, HttpException, Inject, Post } from "@nestjs/common";
import { Public } from "../rbac/decorators";
import { NOTIFICATION_DIGEST_SERVICE_TOKEN_HASH } from "../notifications/notification-digest-scheduler.controller";
import { WorkspaceExportRunner } from "./workspace-export.runner";

/**
 * The trigger for the export sweep (D2, C74). Internal only, authenticated
 * with the same Platform Jobs shared secret as the engine-event pass: only
 * the Platform Jobs worker holds it. `@Public()` bypasses the per-actor
 * RBAC guard because there is no user here; `authorize` is the boundary in
 * its place. A controller may import a runner only as a listed trigger
 * controller (system-caller.spec.ts names this file alongside the
 * engine-event scheduler).
 */
@Controller("internal/workspace-exports")
export class WorkspaceExportTriggerController {
  constructor(
    private readonly runner: WorkspaceExportRunner,
    @Inject(NOTIFICATION_DIGEST_SERVICE_TOKEN_HASH) private readonly tokenHash: string,
  ) {}

  @Public()
  @Post("process-pending")
  @HttpCode(200)
  async processPending(@Headers("authorization") auth?: string) {
    this.authorize(auth);
    const result = await this.runner.run();
    return {
      tenants: result.tenants,
      tenants_failed: result.tenantsFailed,
      exports_processed: result.exportsProcessed,
      exports_failed: result.exportsFailed,
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
          instance: "/internal/workspace-exports/process-pending",
        },
        401,
      );
    }
  }
}
