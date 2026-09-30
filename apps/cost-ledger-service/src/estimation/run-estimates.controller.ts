import { BadRequestException, Body, Controller, Post } from "@nestjs/common";

import { RunEstimateValidationError, RunEstimatesService } from "./run-estimates.service";

interface WorstCaseBody {
  readonly tenantId?: unknown;
  readonly lines?: unknown;
}

interface RunsAverageBody {
  readonly tenantId?: unknown;
  readonly workspaceId?: unknown;
  readonly runIds?: unknown;
}

@Controller("costs")
export class RunEstimatesController {
  constructor(private readonly estimates: RunEstimatesService) {}

  @Post("worst-case")
  async worstCase(
    @Body() body: WorstCaseBody,
  ): Promise<{ readonly internal_minor: string; readonly billable_minor: string; readonly unpriced_lines: string }> {
    try {
      const result = await this.estimates.worstCase({ tenantId: body?.tenantId, lines: body?.lines });
      return { internal_minor: result.internalMinor, billable_minor: result.billableMinor, unpriced_lines: result.unpricedLines };
    } catch (error: unknown) {
      throw toBadRequest(error);
    }
  }

  @Post("runs-average")
  async runsAverage(
    @Body() body: RunsAverageBody,
  ): Promise<{ readonly average_billable_minor: string | null; readonly run_count: string }> {
    try {
      const result = await this.estimates.runsAverage({
        tenantId: body?.tenantId,
        workspaceId: body?.workspaceId,
        runIds: body?.runIds,
      });
      return { average_billable_minor: result.averageBillableMinor, run_count: result.runCount };
    } catch (error: unknown) {
      throw toBadRequest(error);
    }
  }
}

function toBadRequest(error: unknown): unknown {
  return error instanceof RunEstimateValidationError ? new BadRequestException(error.message) : error;
}
