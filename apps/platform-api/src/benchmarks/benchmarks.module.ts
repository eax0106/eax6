import { MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";

import { resolveRuntimeSecret } from "../identity/identity.module";
import { EvalHistoryClient, historyConfig } from "./history.client";

import { EngineModule } from "../engine";
import { StaffAuthMiddleware, StaffModule } from "../staff";
import { BenchmarksController } from "./benchmarks.controller";
import { BenchmarksExceptionFilter } from "./benchmarks-exception.filter";
import { BenchmarksService } from "./benchmarks.service";

@Module({
  imports: [EngineModule, StaffModule],
  controllers: [BenchmarksController],
  providers: [BenchmarksService, BenchmarksExceptionFilter, { provide: EvalHistoryClient, useFactory: () => new EvalHistoryClient(historyConfig(process.env), resolveRuntimeSecret) }],
})
export class BenchmarksModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(StaffAuthMiddleware).forRoutes(BenchmarksController);
  }
}
