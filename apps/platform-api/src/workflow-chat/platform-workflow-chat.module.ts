import { Module } from "@nestjs/common";
import { EngineModule } from "../engine";
import { IdempotencyModule } from "../idempotency";
import { WorkflowModule } from "../workflows/workflow.module";
import { RunModule } from "../runs/run.module";
import { CostsModule } from "../costs/costs.module";
import { PlannerFacadeModule } from "../planner-facade/planner-facade.module";
import { WorkflowExceptionFilter } from "../workflows/workflow-exception.filter";
import { PlatformWorkflowChatController } from "./platform-workflow-chat.controller";
import { PlatformWorkflowChatService } from "./platform-workflow-chat.service";

@Module({
  imports: [EngineModule, IdempotencyModule, WorkflowModule, RunModule, CostsModule, PlannerFacadeModule],
  controllers: [PlatformWorkflowChatController],
  providers: [PlatformWorkflowChatService, WorkflowExceptionFilter],
})
export class PlatformWorkflowChatModule {}
