import { Module } from "@nestjs/common";
import { EngineModule } from "../engine";
import { IdempotencyModule } from "../idempotency";
import { BudgetController } from "./budget.controller";
import { BudgetService } from "./budget.service";

@Module({
  imports: [IdempotencyModule, EngineModule],
  controllers: [BudgetController],
  providers: [BudgetService],
})
export class BudgetModule {}
