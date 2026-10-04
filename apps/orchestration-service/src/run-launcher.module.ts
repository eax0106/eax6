import { BlackboardService } from "./blackboard/blackboard.service";
import { parseRedisHostPort } from "./config/blackboard-environment";
import { Module } from "@nestjs/common";
import { ProvisioningClient, TemporalDurableExecutionProvider, RedisCacheProvider } from "@alterx/adapters";

import { RunLauncherService } from "./runs/run-launcher.service";
import { DurableRunQueue } from "./runs/durable-run-queue.service";
import { ProjectRunProvisioningService } from "./runs/project-run-provisioning.service";
import { PROVISIONING_CLIENT_PROTO_PATH } from "./runs/provisioning-client.constants";
import { loadRunLauncherEnvironment } from "./config/run-launcher-environment";
import { runLearningAuditClient } from "./runs/run-learning-audit";
import {
  OrchestrationInfrastructureModule,
  buildRunBudgetGate,
  buildRunOutcomeService,
  internalM2mTokenProvider,
  orchestrationStore,
  identityTenantGatewayEnvironment,
} from "./orchestration-infrastructure.module";

/**
 * Extracted ahead of the rest of ExecutionRuntimeModule (Step 6 in
 * docs/design/app-module-split.md) because IngressModule (Step 4) needs
 * RunLauncherService injected, and a provider still registered directly on
 * AppModule isn't visible to a module AppModule imports -- Nest only
 * resolves through explicit module exports. This is the one deviation from
 * the design doc's stated step order, recorded there as a discovered gap
 * rather than silently reordered. ExecutionRuntimeModule (Step 6) will
 * absorb this module's contents alongside Nodeexec/Recovery/run-state
 * rather than re-defining RunLauncherService a second time.
 */
@Module({
  imports: [OrchestrationInfrastructureModule],
  providers: [
    {
      provide: RunLauncherService,
      useFactory: () => {
        const dbConfig = identityTenantGatewayEnvironment(process.env);
        const store = orchestrationStore(dbConfig);
        const runLauncherConfig = loadRunLauncherEnvironment(process.env);
        const durable = new TemporalDurableExecutionProvider({
          address: runLauncherConfig.temporalAddress,
          namespace: runLauncherConfig.temporalNamespace,
          taskQueue: runLauncherConfig.taskQueue,
          ...(runLauncherConfig.temporalApiKey === undefined
            ? {}
            : { apiKey: runLauncherConfig.temporalApiKey }),
        });
        return new RunLauncherService(
          store,
          durable,
          buildRunOutcomeService(),
          new ProjectRunProvisioningService(
            store,
            new ProvisioningClient({
              address: runLauncherConfig.provisioningServiceAddress,
              protoPath: PROVISIONING_CLIENT_PROTO_PATH,
              accessTokenProvider: internalM2mTokenProvider(),
            }),
          ),
          new DurableRunQueue(store),
          buildRunBudgetGate(process.env),
          runLearningAuditClient(process.env),
          new BlackboardService(store, new RedisCacheProvider(parseRedisHostPort(dbConfig.redisUrl))),
        );
      },
    },
  ],
  exports: [RunLauncherService],
})
export class RunLauncherModule {}
