import { BadRequestException, Controller, Get, Param, Query } from "@nestjs/common";

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
  ): Promise<{ readonly node_costs: readonly { readonly node_execution_id: string; readonly internal_cost_minor: string; readonly event_count: number }[] }> {
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
