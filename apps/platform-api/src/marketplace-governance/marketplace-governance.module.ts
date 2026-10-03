import { MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { AdminAuditModule } from "../admin-audit";
import { StaffAuthMiddleware, StaffModule } from "../staff";
import { sharedPool } from "../db/shared-pool";
import { MarketplaceGovernanceController } from "./marketplace-governance.controller";
import { MarketplaceGovernanceExceptionFilter } from "./marketplace-governance-exception.filter";
import { MarketplaceGovernanceRepository } from "./marketplace-governance.repository";
import { MarketplaceGovernanceService } from "./marketplace-governance.service";
import { ToolVersionReviewRepository } from "./tool-version-review.repository";
import { ToolVersionReviewService } from "./tool-version-review.service";

@Module({
  imports: [AdminAuditModule, StaffModule],
  controllers: [MarketplaceGovernanceController],
  providers: [
    {
      provide: MarketplaceGovernanceRepository,
      useFactory: () => new MarketplaceGovernanceRepository(
        process.env.OPERATIONS_MARKETPLACE_DATABASE_URL
          ? sharedPool(process.env.OPERATIONS_MARKETPLACE_DATABASE_URL)
          : undefined,
        false,
      ),
    },
    MarketplaceGovernanceService,
    { provide: ToolVersionReviewRepository, useFactory: () => new ToolVersionReviewRepository(process.env.OPERATIONS_MARKETPLACE_DATABASE_URL ? sharedPool(process.env.OPERATIONS_MARKETPLACE_DATABASE_URL) : undefined,false) },
    ToolVersionReviewService,
    MarketplaceGovernanceExceptionFilter,
  ],
})
export class MarketplaceGovernanceModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(StaffAuthMiddleware).forRoutes(MarketplaceGovernanceController);
  }
}
