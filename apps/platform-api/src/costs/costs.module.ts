import { Module } from "@nestjs/common";
import {
  ENGINE_CONFIG,
  ENGINE_M2M_TOKEN_PROVIDER,
  EngineModule,
  type EngineConfig,
  type EngineM2mTokenProvider,
} from "../engine";
import { CostsController, StaffCostsController, WorkflowCostsController } from "./costs.controller";
import { CostsExceptionFilter } from "./costs-exception.filter";
import { CostsService } from "./costs.service";
import { StaffCostsService } from "./staff-costs.service";

@Module({
  imports: [EngineModule],
  controllers: [CostsController, WorkflowCostsController, StaffCostsController],
  providers: [
    CostsService,
    CostsExceptionFilter,
    {
      provide: StaffCostsService,
      useFactory: (config: EngineConfig, m2m: EngineM2mTokenProvider) => new StaffCostsService(config, m2m),
      inject: [ENGINE_CONFIG, ENGINE_M2M_TOKEN_PROVIDER],
    },
  ],
  exports: [CostsService],
})
export class CostsModule {}
