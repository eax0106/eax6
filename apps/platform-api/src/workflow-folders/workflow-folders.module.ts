import { Module } from "@nestjs/common";
import { EngineModule } from "../engine";
import { IdempotencyModule } from "../idempotency";
import { WorkflowExceptionFilter } from "../workflows/workflow-exception.filter";
import { PlatformWorkflowFoldersController } from "./workflow-folders.controller";

@Module({ imports: [EngineModule, IdempotencyModule], controllers: [PlatformWorkflowFoldersController], providers: [WorkflowExceptionFilter] })
export class WorkflowFoldersModule {}
