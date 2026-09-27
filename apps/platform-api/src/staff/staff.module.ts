import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { StaffController } from "./staff.controller";
import { StaffSessionController } from "./staff-session.controller";
import { StaffAuthMiddleware } from "./staff.middleware";
import { StaffRepository } from "./staff.repository";
import { StaffService } from "./staff.service";
import { SupportAccessController } from "./support-access.controller";
import { SupportAccessExceptionFilter } from "./support-access-exception.filter";
import { AdminAuditModule } from "../admin-audit";
import { sharedPool } from "../db/shared-pool";

@Module({
  imports: [AdminAuditModule],
  controllers: [StaffController, StaffSessionController, SupportAccessController],
  providers: [
    {
      provide: StaffRepository,
      useFactory: () => new StaffRepository(sharedPool(process.env.DATABASE_URL)),
    },
    StaffService,
    StaffAuthMiddleware,
    SupportAccessExceptionFilter,
  ],
  exports: [StaffService, StaffAuthMiddleware],
})
export class StaffModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(StaffAuthMiddleware).forRoutes(StaffController, StaffSessionController);
  }
}
