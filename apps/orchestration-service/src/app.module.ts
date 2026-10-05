import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller";
import { OrchestrationInfrastructureModule } from "./orchestration-infrastructure.module";
import { SecurityModule } from "./security.module";
import { ArtifactModule } from "./artifact.module";
import { OperationsModule } from "./operations.module";
import { RunLauncherModule } from "./run-launcher.module";
import { IngressModule } from "./ingress.module";
import { WorkflowAuthoringModule } from "./workflow-authoring.module";
import { ExecutionRuntimeModule } from "./execution-runtime.module";
import { BenchmarkSimulationModule } from "./benchmark-simulation.module";

/**
 * Thin composition root -- Step 7/7 of docs/design/app-module-split.md.
 * Every provider, controller, and piece of construction logic that used
 * to live directly on this module has been extracted into a cohesive
 * feature module. This file now only imports them and registers the one
 * controller (health check) that doesn't belong to any feature domain.
 */
@Module({
  imports: [
    OrchestrationInfrastructureModule,
    SecurityModule,
    ArtifactModule,
    OperationsModule,
    RunLauncherModule,
    IngressModule,
    WorkflowAuthoringModule,
    ExecutionRuntimeModule,
    BenchmarkSimulationModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
