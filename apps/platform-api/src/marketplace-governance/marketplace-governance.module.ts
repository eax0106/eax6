import { MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { AdminAuditModule } from "../admin-audit";
import { StaffAuthMiddleware, StaffModule } from "../staff";
import { registryPackageScanConfiguration } from "../config/env.schema";
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
        operationsMarketplacePool(),
        false,
      ),
    },
    MarketplaceGovernanceService,
    { provide: ToolVersionReviewRepository, useFactory: () => new ToolVersionReviewRepository(operationsMarketplacePool(),false) },
    ToolVersionReviewService,
    MarketplaceGovernanceExceptionFilter,
  ],
})
export class MarketplaceGovernanceModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(StaffAuthMiddleware).forRoutes(MarketplaceGovernanceController);
  }
}

function operationsMarketplacePool() {
  const { operationsDatabaseUrl } = registryPackageScanConfiguration();
  return operationsDatabaseUrl ? sharedPool(operationsDatabaseUrl) : undefined;
}
