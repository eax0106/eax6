import { Module } from "@nestjs/common";
import {
  ConcurrencyExceptionFilter,
  ETAG_RESOURCE_RESOLVER,
  EtagResponseInterceptor,
  IfMatchGuard,
} from "../concurrency";
import { EngineModule } from "../engine";
import { IdempotencyModule } from "../idempotency";
import { NodeTypeController } from "./node-type.controller";
import { WorkflowController } from "./workflow.controller";
import { WorkflowEtagResolver } from "./workflow-etag.resolver";
import { WorkflowExceptionFilter } from "./workflow-exception.filter";
import { WorkflowService } from "./workflow.service";
import { PlannerFacadeModule } from "../planner-facade/planner-facade.module";

@Module({
  imports: [EngineModule, IdempotencyModule, PlannerFacadeModule],
  controllers: [WorkflowController, NodeTypeController],
  providers: [
    WorkflowService,
    WorkflowEtagResolver,
    {
      provide: ETAG_RESOURCE_RESOLVER,
      useExisting: WorkflowEtagResolver,
    },
    IfMatchGuard,
    EtagResponseInterceptor,
    ConcurrencyExceptionFilter,
    WorkflowExceptionFilter,
  ],
  exports: [WorkflowService],
})
export class WorkflowModule {}
