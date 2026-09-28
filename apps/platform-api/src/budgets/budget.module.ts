import { Module } from "@nestjs/common";
import { CostsModule } from "../costs/costs.module";
import { sharedPool } from "../db/shared-pool";
import { IdempotencyModule } from "../idempotency";
import { BudgetController } from "./budget.controller";
import { BudgetRepository } from "./budget.repository";
import { BudgetService } from "./budget.service";

@Module({
  imports: [IdempotencyModule, CostsModule],
  controllers: [BudgetController],
  providers: [
    {
      provide: BudgetRepository,
      useFactory: () => new BudgetRepository(sharedPool(process.env.DATABASE_URL), false),
    },
    BudgetService,
  ],
})
export class BudgetModule {}
