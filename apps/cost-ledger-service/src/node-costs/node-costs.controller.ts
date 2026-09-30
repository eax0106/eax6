import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";

import { NodeCostsService, NodeCostValidationError } from "./node-costs.service";
import { RunTotalService } from "./run-total.service";

// unknown, not string: these are absent when a caller omits them, and the
// declared type is not enforced at the wire boundary. CostSummaryController's
// SummaryQuery already models them this way.
interface NodeCostsQuery {
  readonly tenantId?: unknown;
  readonly workspaceId?: unknown;
}

@Controller("costs")
export class NodeCostsController {
  constructor(
    private readonly nodeCosts: NodeCostsService,
    private readonly runTotals: RunTotalService,
  ) {}

  /** D24: each run's billed cost, for what a workflow costs its tenant. */
  @Post("run-totals")
  @HttpCode(200)
  async getRunTotals(
    @Body() body: { readonly tenantId?: unknown; readonly workspaceId?: unknown; readonly runIds?: unknown } | undefined,
  ): Promise<{ readonly runs: readonly { readonly run_id: string; readonly billable_minor: string }[] }> {
    try {
      const totals = await this.runTotals.getForRuns({
        tenantId: body?.tenantId,
        workspaceId: body?.workspaceId,
        runIds: body?.runIds,
      });
      return { runs: totals.map((total) => ({ run_id: total.runId, billable_minor: total.billableMinor })) };
    } catch (error: unknown) {
      if (error instanceof NodeCostValidationError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  @Get("run-total/:runId")
  async getRunTotal(
    @Param("runId") runId: string,
    @Query() query: NodeCostsQuery,
  ): Promise<{ readonly billable_minor: string; readonly event_count: string }> {
    try {
      const total = await this.runTotals.getForRun({ tenantId: query.tenantId, workspaceId: query.workspaceId, runId });
      return { billable_minor: total.billableMinor, event_count: total.eventCount };
    } catch (error: unknown) {
      if (error instanceof NodeCostValidationError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  @Get("by-run/:runId")
  async getForRun(
    @Param("runId") runId: string,
    @Query() query: NodeCostsQuery,
  ): Promise<{
    readonly node_costs: readonly {
      readonly node_execution_id: string;
      readonly internal_cost_minor: string;
      readonly billable_minor: string;
      readonly event_count: number;
    }[];
  }> {
    try {
      const nodeCosts = await this.nodeCosts.getForRun({
        tenantId: query.tenantId,
        workspaceId: query.workspaceId,
        runId,
      });
      return {
        node_costs: nodeCosts.map((cost) => ({
          node_execution_id: cost.nodeExecutionId,
          internal_cost_minor: cost.internalCostMinor,
          // D24: what the tenant is shown for the step.
          billable_minor: this.runTotals.bill(cost.internalCostMinor),
          event_count: cost.eventCount,
        })),
      };
    } catch (error: unknown) {
      if (error instanceof NodeCostValidationError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}
