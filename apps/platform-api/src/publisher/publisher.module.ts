import { MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { EngineModule } from "../engine";
import { SellerGovernanceController } from "./seller-governance.controller";
import { SellerGovernanceRepository } from "./seller-governance.repository";
import { AdminAuditModule } from "../admin-audit";
import { sharedPool } from "../db/shared-pool";
import { marketplaceDatabaseConfiguration } from "../config/env.schema";
import { StaffAuthMiddleware, StaffModule } from "../staff";
import { AdminPublisherController } from "./admin-publisher.controller";
import { AdminPublisherRepository } from "./admin-publisher.repository";
import { AdminPublisherService } from "./admin-publisher.service";
import { ManualReviewKycProvider } from "./manual-review-kyc-provider";
import { PublisherController } from "./publisher.controller";
import { PublisherRepository } from "./publisher.repository";
import { PublisherService } from "./publisher.service";

@Module({
  imports: [AdminAuditModule, StaffModule, EngineModule],
  controllers: [PublisherController, AdminPublisherController, SellerGovernanceController],
  providers: [
    {
      provide: AdminPublisherRepository,
      useFactory: () => {
        const { operationsDatabaseUrl } = marketplaceDatabaseConfiguration();
        return new AdminPublisherRepository(operationsDatabaseUrl ? sharedPool(operationsDatabaseUrl) : undefined, false);
      },
    },
    AdminPublisherService,
    { provide: SellerGovernanceRepository, useFactory: () => new SellerGovernanceRepository(sharedPool(marketplaceDatabaseConfiguration().databaseUrl)) },
    { provide: PublisherRepository, useFactory: () => new PublisherRepository(sharedPool(marketplaceDatabaseConfiguration().databaseUrl), false) },
    ManualReviewKycProvider,
    { provide: PublisherService, inject: [PublisherRepository, ManualReviewKycProvider], useFactory: (repository: PublisherRepository, kyc: ManualReviewKycProvider) => new PublisherService(repository, kyc) },
  ],
})
export class PublisherModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(StaffAuthMiddleware).forRoutes(AdminPublisherController);
  }
}
