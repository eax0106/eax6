import { Module } from "@nestjs/common";
import type { AuditEventHandler } from "@alterx/shared-clients";
import { engineAuditClientFromEnvironment } from "../audit/engine-audit-client";
import { PlatformDb } from "../signup/platform-db";
import { PlannerFacadeService } from "./planner-facade.service";
import { PlannerFacadeController } from "./planner-facade.controller";
import { EngineModule } from "../engine/engine.module";
import { IdempotencyModule } from "../idempotency";
import { sharedPool } from "../db/shared-pool";
import { TenantResidencyRepository } from "./tenant-residency.repository";
import { WorkflowSafeguardsController } from "./workflow-safeguards.controller";
import { WorkflowSafeguardsService } from "./workflow-safeguards.service";

const WORKFLOW_SAFEGUARDS_AUDIT_CLIENT = Symbol("WORKFLOW_SAFEGUARDS_AUDIT_CLIENT");

@Module({
  imports: [EngineModule, IdempotencyModule],
  providers: [
    PlannerFacadeService,
    {
      provide: TenantResidencyRepository,
      useFactory: () => new TenantResidencyRepository(sharedPool(process.env.DATABASE_URL)),
    },
    { provide: WORKFLOW_SAFEGUARDS_AUDIT_CLIENT, useFactory: engineAuditClientFromEnvironment },
    {
      provide: WorkflowSafeguardsService,
      inject: [WORKFLOW_SAFEGUARDS_AUDIT_CLIENT],
      useFactory: (audit: AuditEventHandler) =>
        new WorkflowSafeguardsService(new PlatformDb(sharedPool(process.env.DATABASE_URL)), audit),
    },
  ],
  controllers: [PlannerFacadeController, WorkflowSafeguardsController],
  exports: [PlannerFacadeService],
})
export class PlannerFacadeModule {}
