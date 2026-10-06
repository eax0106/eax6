import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";

import { ActorContext, RequireWorkspaceRole, type ActorContextType } from "../rbac";
import { BENCHMARK_READERS, BENCHMARK_WRITERS, TenantBenchmarksService } from "./tenant-benchmarks.service";

@Controller("/api/v1/benchmarks")
export class TenantBenchmarksController {
  constructor(private readonly benchmarks: TenantBenchmarksService) {}

  @Get("datasets")
  @RequireWorkspaceRole(...BENCHMARK_READERS)
  listDatasets(@ActorContext() actor?: ActorContextType) {
    return this.benchmarks.listDatasets(actor);
  }

  @Post("datasets")
  @RequireWorkspaceRole(...BENCHMARK_WRITERS)
  createDataset(@Body() body: unknown, @ActorContext() actor?: ActorContextType) {
    return this.benchmarks.createDataset(actor, body);
  }

  @Get("datasets/:datasetId")
  @RequireWorkspaceRole(...BENCHMARK_READERS)
  getDataset(@Param("datasetId") datasetId: string, @ActorContext() actor?: ActorContextType) {
    return this.benchmarks.getDataset(actor, datasetId);
  }

  @Post("datasets/:datasetId/runs")
  @HttpCode(202)
  @RequireWorkspaceRole(...BENCHMARK_WRITERS)
  startRun(@Param("datasetId") datasetId: string, @Body() body: unknown, @ActorContext() actor?: ActorContextType) {
    return this.benchmarks.startRun(actor, datasetId, body);
  }

  @Get("runs")
  @RequireWorkspaceRole(...BENCHMARK_READERS)
  listRuns(@Query() query: unknown, @ActorContext() actor?: ActorContextType) {
    return this.benchmarks.listRuns(actor, query);
  }

  @Get("runs/:runId")
  @RequireWorkspaceRole(...BENCHMARK_READERS)
  getRun(@Param("runId") runId: string, @ActorContext() actor?: ActorContextType) {
    return this.benchmarks.getRun(actor, runId);
  }
}
