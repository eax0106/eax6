import { createHash, timingSafeEqual } from "node:crypto";
import { Body, Controller, Headers, HttpCode, HttpException, Inject, Post } from "@nestjs/common";
import { Public } from "../../rbac/decorators";
import { NOTIFICATION_DIGEST_SERVICE_TOKEN_HASH } from "../notification-digest-scheduler.controller";
import { EngineEventNotificationRunner } from "./engine-event-notification.runner";
import { DriftSuggestionRunner, type DriftSuggestion } from "./drift-suggestion.runner";

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
    private readonly drift: DriftSuggestionRunner,
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

  /**
   * Section 17: the Drift Detector's sweep (Platform Jobs worker) reports an
   * agent it flagged; the people whose workflows it worked in are told.
   */
  @Public()
  @Post("drift-suggestions")
  @HttpCode(200)
  async driftSuggestion(@Body() body: unknown, @Headers("authorization") auth?: string) {
    this.authorize(auth, "/internal/notifications/drift-suggestions");
    const suggestion = parseDriftSuggestion(body);
    return { notifications_created: await this.drift.run(suggestion) };
  }

  private authorize(value: string | undefined, instance = "/internal/notifications/run-engine-producers"): void {
    const token = value?.startsWith("Bearer ") ? value.slice(7) : "";
    const actual = createHash("sha256").update(token).digest();
    const expected = Buffer.from(this.tokenHash, "hex");
    if (!token || expected.length !== actual.length || !timingSafeEqual(actual, expected)) {
      throw new HttpException(
        {
          type: "https://alter.dev/problems/unauthorized",
          title: "Unauthorized",
          status: 401,
          instance,
        },
        401,
      );
    }
  }
}

const UUID_V7 = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const TENANT_ID = new RegExp(`^ten_${UUID_V7}$`, "i");
const AGENT_ID = new RegExp(`^agt_${UUID_V7}$`, "i");
const TASK_CLASS = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

function parseDriftSuggestion(body: unknown): DriftSuggestion {
  const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const { tenant_id: tenantId, agent_id: agentId, task_class: taskClass, action_taken: action } = value;
  if (
    typeof tenantId !== "string" || !TENANT_ID.test(tenantId) ||
    typeof agentId !== "string" || !AGENT_ID.test(agentId) ||
    typeof taskClass !== "string" || !TASK_CLASS.test(taskClass) ||
    (action !== "flagged" && action !== "weight_decay")
  ) {
    throw new HttpException(
      {
        type: "https://alter.dev/problems/validation",
        title: "Bad Request",
        status: 400,
        detail: "tenant_id, agent_id, task_class and action_taken (flagged or weight_decay) are required",
        instance: "/internal/notifications/drift-suggestions",
      },
      400,
    );
  }
  return { tenantId, agentId, taskClass, action };
}
