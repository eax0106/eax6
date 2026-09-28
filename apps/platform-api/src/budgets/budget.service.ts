import { Injectable, Logger } from "@nestjs/common";
import { v7 as uuidv7 } from "uuid";
import { CostsService } from "../costs/costs.service";
import type { ActorContext } from "../rbac/types";
import { BudgetRepository } from "./budget.repository";
import { budgetNotFound } from "./problem";
import type { BudgetActor, BudgetRecord, BudgetView, CreateBudgetInput, UpdateBudgetInput } from "./types";

/**
 * Budgets (task B2.9b): a workspace's monthly spending limits. Spend is the
 * cost ledger's billable total for the current month; a ledger outage leaves
 * spend unknown rather than failing the page. Thresholds are stored here and
 * enforced by the Run Manager's budget gate (C10) and notifications (B3.1).
 */
@Injectable()
export class BudgetService {
  private readonly logger = new Logger(BudgetService.name);

  constructor(
    private readonly repository: BudgetRepository,
    private readonly costs: CostsService,
  ) {}

  async list(actor: BudgetActor, context: ActorContext, traceparent: string | undefined, now = new Date()): Promise<BudgetView[]> {
    const budgets = await this.repository.list(actor.tenantId, actor.workspaceId);
    if (budgets.length === 0) return [];
    const spend = await this.monthToDateSpend(context, traceparent, now);
    return budgets.map((budget) => view(budget, spend && spend.currency === budget.currency ? spend.billableMinor : null));
  }

  async create(actor: BudgetActor, input: CreateBudgetInput): Promise<BudgetView> {
    const record = await this.repository.insert({
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      id: `bud_${uuidv7()}`,
      createdBy: actor.userId,
      ...input,
    });
    return view(record, null);
  }

  async update(actor: BudgetActor, id: string, input: UpdateBudgetInput, instance: string): Promise<BudgetView> {
    const record = await this.repository.update(actor.tenantId, actor.workspaceId, id, input);
    if (!record) throw budgetNotFound(instance);
    return view(record, null);
  }

  async remove(actor: BudgetActor, id: string, instance: string): Promise<void> {
    if (!(await this.repository.remove(actor.tenantId, actor.workspaceId, id))) throw budgetNotFound(instance);
  }

  private async monthToDateSpend(
    context: ActorContext,
    traceparent: string | undefined,
    now: Date,
  ): Promise<{ currency: string; billableMinor: number } | undefined> {
    const startAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    try {
      const summary = await this.costs.summary({ startAt, endAt: now.toISOString() }, context, traceparent);
      return { currency: summary.currency, billableMinor: Number(summary.totals.billableMinor) };
    } catch (error) {
      this.logger.warn(`Budget spend unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }
}

function view(record: BudgetRecord, currentSpendMinor: number | null): BudgetView {
  return {
    id: record.id,
    name: record.name,
    amountMinor: record.amountMinor,
    currency: record.currency,
    period: record.period,
    thresholds: record.thresholds,
    enabled: record.enabled,
    currentSpendMinor,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
