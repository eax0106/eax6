import { MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { AdminAuditModule } from "../admin-audit";
import { sharedPool } from "../db/shared-pool";
import { StaffAuthMiddleware, StaffModule } from "../staff";
import { AdminUsersController } from "./admin-users.controller";
import { AdminUsersRepository } from "./admin-users.repository";
import { AdminUsersService } from "./admin-users.service";

@Module({
  imports: [AdminAuditModule, StaffModule],
  controllers: [AdminUsersController],
  providers: [
    {
      provide: AdminUsersRepository,
      useFactory: () => new AdminUsersRepository(sharedPool(process.env.DATABASE_URL), false),
    },
    AdminUsersService,
  ],
})
export class AdminUsersModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(StaffAuthMiddleware).forRoutes(AdminUsersController);
  }
}
