import { Injectable, Logger } from "@nestjs/common";
import { EngineClient } from "../../engine";
import { NotificationService } from "../notification.service";
import { bareId, type EngineEventProducer, type EngineEventProducerContext } from "./engine-event-producer";

interface ThresholdFeed {
  readonly data: readonly {
    readonly id?: unknown;
    readonly workspace_id?: unknown;
    readonly kind?: unknown;
    readonly period?: unknown;
    readonly period_key?: unknown;
    readonly amount_minor?: unknown;
    readonly spent_minor?: unknown;
  }[];
}

/** D3: alerts when a budget's spend this period reaches these shares of its cap. */
export const BUDGET_ALERT_PERCENTS = [80, 50] as const;

/**
 * Budget thresholds (D3): tells a workspace's admins when a budget's spend
 * this period reaches 50% and again at 80%, once per budget, period and
 * threshold. Spend only rises within a period, so only the highest threshold
 * reached is announced: a budget that jumps past both says 80% once.
 */
@Injectable()
export class BudgetThresholdProducer implements EngineEventProducer {
  readonly name = "budget-threshold";
  private readonly logger = new Logger(BudgetThresholdProducer.name);

  constructor(
    private readonly engine: EngineClient,
    private readonly notifications: NotificationService,
  ) {}

  async produce(context: EngineEventProducerContext): Promise<number> {
    const response = await this.engine.get<ThresholdFeed>("/api/v1/budgets/threshold-feed", context.caller);
    let created = 0;
    for (const budget of response.body.data) {
      created += await this.notify(context.tenantId, budget);
    }
    return created;
  }

  private async notify(tenantId: string, budget: ThresholdFeed["data"][number]): Promise<number> {
    const workspaceId = bareId("ws", budget.workspace_id);
    const { id, period, period_key: periodKey, amount_minor: amount, spent_minor: spent } = budget;
    if (
      workspaceId === null ||
      typeof id !== "string" ||
      typeof periodKey !== "string" ||
      (period !== "daily" && period !== "monthly") ||
      !isMinor(amount) || amount <= 0 ||
      !isMinor(spent)
    ) {
      this.logger.warn({ tenantId, message: "budget feed row is malformed; not notified" });
      return 0;
    }
    // Whole-number maths: spent * 100 >= amount * percent.
    const reached = BUDGET_ALERT_PERCENTS.find((percent) => BigInt(spent) * 100n >= BigInt(amount) * BigInt(percent));
    if (reached === undefined) return 0;
    const scope = budget.kind === "workspace" ? "This workspace's" : "A workflow's";
    try {
      return await this.notifications.notifyWorkspaceRolesOnce(["admin"], `budget:${id}:${periodKey}:${reached}`, {
        tenantId,
        workspaceId,
        eventClass: "budget",
        severity: reached >= 80 ? "warning" : "info",
        title: `Budget ${reached}% used`,
        body: `${scope} ${period} budget has reached ${reached}% of its limit.`,
        deepLink: "/app/usage/budgets",
        sourceService: "platform-api.engine-events",
      });
    } catch (error: unknown) {
      this.logger.error({
        tenantId,
        budgetId: id,
        message: "budget threshold notification failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }
}

function isMinor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
