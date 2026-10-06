import { Module } from "@nestjs/common";

import { tenantBenchmarksConfig } from "../config/tenant-benchmarks";
import { resolveRuntimeSecret } from "../identity/identity.module";
import { TenantBenchmarksController } from "./tenant-benchmarks.controller";
import { TenantBenchmarksService } from "./tenant-benchmarks.service";

@Module({
  controllers: [TenantBenchmarksController],
  providers: [{ provide: TenantBenchmarksService, useFactory: () => new TenantBenchmarksService(tenantBenchmarksConfig(), resolveRuntimeSecret) }],
})
export class TenantBenchmarksModule {}
