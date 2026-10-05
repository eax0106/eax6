import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, UseFilters } from "@nestjs/common";

import { RequireStaffRole } from "../rbac/decorators";
import { BenchmarksExceptionFilter } from "./benchmarks-exception.filter";
import { BenchmarksService } from "./benchmarks.service";

@Controller("/api/v1/admin/benchmarks")
@UseFilters(BenchmarksExceptionFilter)
export class BenchmarksController {
  constructor(private readonly benchmarks: BenchmarksService) {}

  @Get("runs")
  @RequireStaffRole("staff_admin", "staff_security")
  listRuns(@Query() query: unknown, @Headers("traceparent") traceparent?: string) {
    return this.benchmarks.listRuns(query,traceparent);
  }

  @Post("actions/run")
  @HttpCode(200)
  @RequireStaffRole("staff_admin")
  run(
    @Body() body: unknown,
    @Headers("traceparent") traceparent: string | undefined,
  ) {
    return this.benchmarks.run(body, traceparent);
  }

  @Get("release-gates/:gateId")
  @RequireStaffRole("staff_admin", "staff_security")
  releaseGate(
    @Param("gateId") gateId: string,
    @Query("evaluation_run_id") evaluationRunId: string | undefined,
    @Headers("traceparent") traceparent: string | undefined,
  ) {
    return this.benchmarks.releaseGate(gateId, evaluationRunId, traceparent);
  }
}
