import { Module } from "@nestjs/common";
import { engineAuditClientFromEnvironment } from "../audit/engine-audit-client";
import { EngineModule } from "../engine";
import { IdempotencyModule } from "../idempotency";
import { WorkflowExceptionFilter } from "../workflows/workflow-exception.filter";
import { PlatformWorkflowTemplatesController } from "./workflow-templates.controller";
import { PlatformWorkflowTemplatesService, WORKFLOW_TEMPLATES_AUDIT_CLIENT } from "./workflow-templates.service";

@Module({
  imports: [EngineModule, IdempotencyModule],
  controllers: [PlatformWorkflowTemplatesController],
  providers: [
    { provide: WORKFLOW_TEMPLATES_AUDIT_CLIENT, useFactory: engineAuditClientFromEnvironment },
    PlatformWorkflowTemplatesService,
    WorkflowExceptionFilter,
  ],
})
export class PlatformWorkflowTemplatesModule {}
