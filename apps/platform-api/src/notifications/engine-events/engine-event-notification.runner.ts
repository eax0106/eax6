import { randomBytes } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { createSystemCallerContext } from "../../system-jobs/system-caller";
import { ENGINE_EVENT_PRODUCERS, type EngineEventProducer } from "./engine-event-producer";
import { SystemNotificationStore } from "../system-notification-store";

export interface EngineEventRunResult {
  readonly tenants: number;
  readonly tenantsFailed: number;
  readonly notificationsCreated: number;
}

/**
 * The scheduled pass behind engine-event notifications (D1): for every live
 * tenant it reads the engine as `system:platform-jobs` and lets each producer
 * turn what it finds into notifications. One tenant or one producer failing
 * never stops the rest; the failure is counted and logged.
 */
@Injectable()
export class EngineEventNotificationRunner {
  private readonly logger = new Logger(EngineEventNotificationRunner.name);

  constructor(
    private readonly tenants: SystemNotificationStore,
    @Inject(ENGINE_EVENT_PRODUCERS) private readonly producers: readonly EngineEventProducer[],
  ) {}

  async run(now: Date = new Date()): Promise<EngineEventRunResult> {
    const tenantIds = await this.tenants.listActiveTenantIds();
    let tenantsFailed = 0;
    let notificationsCreated = 0;
    for (const tenantId of tenantIds) {
      const caller = createSystemCallerContext({ tenantId, traceparent: newTraceparent() });
      let failed = false;
      for (const producer of this.producers) {
        try {
          notificationsCreated += await producer.produce({ tenantId, caller, now });
        } catch (error: unknown) {
          failed = true;
          this.logger.error({
            tenantId,
            producer: producer.name,
            message: "engine-event producer failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (failed) tenantsFailed += 1;
    }
    return { tenants: tenantIds.length, tenantsFailed, notificationsCreated };
  }
}

function newTraceparent(): string {
  return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}
