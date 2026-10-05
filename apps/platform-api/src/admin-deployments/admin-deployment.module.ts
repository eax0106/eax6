import { MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { AdminAuditModule } from "../admin-audit";
import {deploymentAdminDatabaseFromEnvironment} from "./config";
import {sharedPool} from "../db/shared-pool";
import {AdminAuditService} from "../admin-audit";
import {DeploymentAdminClient} from "../engine";
import { EngineModule } from "../engine";
import { StaffAuthMiddleware, StaffModule } from "../staff";
import { AdminDeploymentController } from "./admin-deployment.controller";
import { AdminDeploymentService } from "./admin-deployment.service";

@Module({
  imports: [AdminAuditModule, EngineModule, StaffModule],
  controllers: [AdminDeploymentController],
  providers: [{provide:AdminDeploymentService,inject:[DeploymentAdminClient,AdminAuditService],useFactory:(client:DeploymentAdminClient,audit:AdminAuditService)=>new AdminDeploymentService(client,audit,sharedPool(deploymentAdminDatabaseFromEnvironment(process.env)))}],
})
export class AdminDeploymentModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(StaffAuthMiddleware).forRoutes(AdminDeploymentController);
  }
}
