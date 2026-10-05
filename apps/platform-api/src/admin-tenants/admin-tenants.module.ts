import { MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { AdminAuditModule } from "../admin-audit";
import { StaffAuthMiddleware, StaffModule } from "../staff";
import { sharedPool } from "../db/shared-pool";
import { AdminTenantsController } from "./admin-tenants.controller";
import { AdminTenantsExceptionFilter } from "./admin-tenants-exception.filter";
import { AdminTenantsRepository } from "./admin-tenants.repository";
import { AdminTenantsService } from "./admin-tenants.service";
import { EngineModule, TenantActivityClient } from "../engine";
import { AdminAuditService } from "../admin-audit";
import { AdminTenantActivityService } from "./admin-tenant-activity.service";

@Module({
  imports: [AdminAuditModule, EntitlementsModule, StaffModule, EngineModule],
  controllers: [AdminTenantsController],
  providers: [
    {
      provide: AdminTenantsRepository,
      useFactory: () => new AdminTenantsRepository(sharedPool(process.env.DATABASE_URL), false),
    },
    AdminTenantsService,
    { provide: AdminTenantActivityService, inject: [AdminTenantsRepository, TenantActivityClient, AdminAuditService],
      useFactory: (repository: AdminTenantsRepository, activity: TenantActivityClient, audit: AdminAuditService) => new AdminTenantActivityService(repository, activity, audit) },
    AdminTenantsExceptionFilter,
  ],
})
export class AdminTenantsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(StaffAuthMiddleware).forRoutes(AdminTenantsController);
  }
}
