import { Module } from "@nestjs/common";
import { EngineModule } from "../engine";
import { CostsController } from "./costs.controller";
import { CostsExceptionFilter } from "./costs-exception.filter";
import { CostsService } from "./costs.service";

@Module({
  imports: [EngineModule],
  controllers: [CostsController],
  providers: [CostsService, CostsExceptionFilter],
  exports: [CostsService],
})
export class CostsModule {}
