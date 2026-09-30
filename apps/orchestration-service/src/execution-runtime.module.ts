import { Module } from "@nestjs/common";
import {
  BLACKBOARD_HANDLER,
  NODEEXEC_HANDLER,
  RECOVERY_HANDLER,
  REGISTRY_HANDLER,
  RUNS_HANDLER,
  BlackboardGrpcController,
  CapabilityServiceClient,
  MemoryServiceClient,
  ModelGatewayClient,
  PerformanceRecorderClient,
  PlannerClient,
  PolicyStoreClient,
  ProvisioningClient,
  SandboxServiceClient,
  SelectionBindingClient,
  AwsSsmParameterProvider,
  NodeexecGrpcController,
  RedisCacheProvider,
  RecoveryGrpcController,
  RegistryGrpcController,
  RunsGrpcController,
  TemporalDurableExecutionProvider,
  ToolGatewayClient,
  VerifyServiceClient,
} from "@alterx/adapters";
import { createMockQueueProvider } from "@alterx/shared-clients";
import { MODELGW_CLIENT_PROTO_PATH } from "./conversation/grpc.constants";
import { GraphCompilerService } from "./compiler/graph-compiler.service";
import { CAPABILITY_CLIENT_PROTO_PATH } from "./compiler/capability-client.constants";
import { RegistryService } from "./registry/registry.service";
import { NodeexecService } from "./registry/nodeexec.service";
import { PostgresRunAcceptanceCheck } from "./registry/run-acceptance-check";
import { SsmSelectionBindingFailClosedConfig } from "./registry/selection-binding-fail-closed-config";
import { NodeExecutionsController } from "./runs/node-executions.controller";
import { NodeExecutionLedgerService } from "./runs/node-execution-ledger.service";
import { RunStreamEventService } from "./runs/run-stream-event.service";
import { RunStreamController } from "./runs/run-stream.controller";
import { RunsController } from "./runs/runs.controller";
import { RunOutcomeService } from "./runs/run-outcome.service";
import { ProjectRunProvisioningService } from "./runs/project-run-provisioning.service";
import { RunWorkspaceLookupService } from "./runs/run-workspace-lookup.service";
import { PROVISIONING_CLIENT_PROTO_PATH } from "./runs/provisioning-client.constants";
import { RUN_LEARNING_AUDIT, RunLearningController } from "./runs/run-learning.controller";
import { runLearningAuditClient } from "./runs/run-learning-audit";
import { RecoveryFeedController } from "./runs/recovery-feed.controller";
import { BudgetsController } from "./budgets/budgets.controller";
import { EngineBudgetService } from "./budgets/budget.service";
import { RunObservabilityController } from "./runs/run-observability.controller";
import { RunObservabilityService } from "./runs/run-observability.service";
import { loadRunLauncherEnvironment } from "./config/run-launcher-environment";
import { ApprovalsController } from "./approvals/approvals.controller";
import { ApprovalsService } from "./approvals/approvals.service";
import { EscalationsController } from "./escalations/escalations.controller";
import { EscalationsService } from "./escalations/escalations.service";
import { createRuntimeNodeHandlerRegistry } from "./registry/node-handler-registry";
import { PostgresVerificationGateReader } from "./registry/verification-gate-reader";
import { PostgresRunFinalizationMemoryWriter } from "./registry/run-finalization-memory-writer";
import { BlackboardGrpcService } from "./blackboard/blackboard-grpc.service";
import { BlackboardService } from "./blackboard/blackboard.service";
import { parseRedisHostPort } from "./config/blackboard-environment";
import { loadConversationManagerEnvironment } from "./config/environment";
import { loadNodeexecEnvironment } from "./config/nodeexec-environment";
import { SANDBOX_CLIENT_PROTO_PATH } from "./registry/sandbox-client.constants";
import { RecoveryPolicyService } from "./recovery/recovery-policy.service";
import { RecoveryDispatchService } from "./recovery/recovery-dispatch.service";
import { PostgresRecoveryRunReader } from "./recovery/recovery-run-reader";
import { RecoveryTriggerService } from "./recovery/recovery-trigger.service";
import { loadRecoveryEnvironment } from "./config/recovery-environment";
import { NodeTypeController } from "./registry/node-type.controller";
import { MEMORY_CLIENT_PROTO_PATH, TOOLGW_CLIENT_PROTO_PATH, VERIFY_CLIENT_PROTO_PATH } from "./registry/nodeexec-grpc.constants";
import { VerifyGateService } from "./registry/verify-gate.service";
import { ArtifactsService } from "./artifacts/artifacts.service";
import { GeneratedFileMaterializer } from "./registry/generated-file-materializer";
import {
  OrchestrationInfrastructureModule,
  buildRunOutcomeService,
  internalM2mTokenProvider,
  orchestrationStore,
  sessionGatewayEnvironment,
} from "./orchestration-infrastructure.module";
import { ArtifactModule } from "./artifact.module";
import { RunLauncherModule } from "./run-launcher.module";

/**
 * HEAL-6: both the RECOVERY_HANDLER gRPC factory and NodeexecService's
 * factory need a fully-wired RecoveryPolicyService (the latter to trigger
 * recovery automatically when a node blocks). Each factory builds its own
 * store/provider instances rather than sharing another factory's closure
 * (same rule ApprovalsService follows below) -- this just avoids repeating
 * the wiring verbatim twice.
 */
function buildRecoveryPolicyService(): RecoveryPolicyService {
  const dbConfig = sessionGatewayEnvironment(process.env);
  const store = orchestrationStore(dbConfig);
  const modelConfig = loadConversationManagerEnvironment(process.env);
  const modelGateway = new ModelGatewayClient({
    address: modelConfig.modelGatewayAddress,
    protoPath: MODELGW_CLIENT_PROTO_PATH,
    accessTokenProvider: internalM2mTokenProvider(),
  });
  const recoveryConfig = loadRecoveryEnvironment(process.env);
  // No Capability Resolver client: compilation stopped resolving node
  // requirements when 0037 dropped the write-only column they were stored in.
  const compiler = new GraphCompilerService(store);
  const planner = new PlannerClient({ baseUrl: recoveryConfig.plannerBaseUrl });
  // swap_agent's real dispatch target -- same Capability Resolver gRPC
  // target `compiler` already uses (a fresh client instance, matching
  // this factory's own no-shared-instances convention), and Selection &
  // Binding lives on the same intelligence-service FastAPI app PlannerClient
  // already targets, just a different route prefix -- no new env var.
  const capabilityResolverForRecovery = new CapabilityServiceClient({
    address: recoveryConfig.capabilityResolverAddress,
    protoPath: CAPABILITY_CLIENT_PROTO_PATH,
    authorization: process.env["INTERNAL_SERVICE_TOKEN"] ?? "",
  });
  const selectionBinding = new SelectionBindingClient({ baseUrl: recoveryConfig.plannerBaseUrl });
  const policyStoreClient = new PolicyStoreClient({
    baseUrl: recoveryConfig.memoryServiceBaseUrl,
  });
  const runLauncherConfig = loadRunLauncherEnvironment(process.env);
  const durable = new TemporalDurableExecutionProvider({
    address: runLauncherConfig.temporalAddress,
    namespace: runLauncherConfig.temporalNamespace,
    taskQueue: runLauncherConfig.taskQueue,
    ...(runLauncherConfig.temporalApiKey === undefined
      ? {}
      : { apiKey: runLauncherConfig.temporalApiKey }),
  });
  const approvals = new ApprovalsService(store, durable);
  const runReader = new PostgresRecoveryRunReader(store);
  // OUT-3: real "degrade" target needs the Blackboard (in-process here,
  // same as BLACKBOARD_HANDLER's own factory below -- no gRPC hop needed,
  // this service and BlackboardService share a process) and the same
  // VerificationGateReader gate.handler.ts/synthesis.handler.ts already
  // use to classify each upstream input's real verification verdict.
  const blackboardCache = new RedisCacheProvider(parseRedisHostPort(dbConfig.redisUrl));
  const blackboard = new BlackboardService(store, blackboardCache);
  const verificationReader = new PostgresVerificationGateReader(store);
  // Built before the dispatcher, because "repair" raises its escalation
  // itself so the reason can name the connection the step was missing.
  const escalations = new EscalationsService(store, durable);
  const dispatch = new RecoveryDispatchService(
    modelGateway,
    compiler,
    planner,
    approvals,
    runReader,
    durable,
    blackboard,
    verificationReader,
    undefined,
    capabilityResolverForRecovery,
    selectionBinding,
    escalations,
  );
  return new RecoveryPolicyService(
    store,
    modelGateway,
    dispatch,
    undefined,
    policyStoreClient,
    escalations,
  );
}

/**
 * Run core, human/runtime state, registry, Nodeexec, and Recovery, all in
 * one module. Per docs/design/app-module-split.md's "What deliberately
 * does not split further" section: Nodeexec creates its own recovery
 * policy via buildRecoveryPolicyService(), and recovery in turn creates
 * compiler/approvals/blackboard/Temporal/capability/selection/policy-store/
 * escalation dependencies. Separating those into different feature modules
 * while preserving fresh-instance semantics would need exported abstract
 * factory tokens and a careful lifetime contract -- not a mechanical
 * import move, and not attempted here. This is the intentional, honestly-
 * reasoned partial boundary the design settled on.
 */
@Module({
  imports: [OrchestrationInfrastructureModule, ArtifactModule, RunLauncherModule],
  controllers: [
    RegistryGrpcController,
    NodeexecGrpcController,
    BlackboardGrpcController,
    RecoveryGrpcController,
    RunsGrpcController,
    NodeExecutionsController,
    RunStreamController,
    RunsController,
    RunObservabilityController,
    RecoveryFeedController,
    BudgetsController,
    RunLearningController,
    ApprovalsController,
    EscalationsController,
    NodeTypeController,
  ],
  providers: [
    {
      provide: EngineBudgetService,
      useFactory: () => new EngineBudgetService(orchestrationStore(sessionGatewayEnvironment(process.env))),
    },
    {
      // No PostgresOrchestrationStoreProvider here -- the Node Type
      // Registry is a global, tenant-free static catalog (see
      // node-type-catalog.ts), not database-backed.
      provide: REGISTRY_HANDLER,
      useClass: RegistryService,
    },
    {
      provide: NODEEXEC_HANDLER,
      useFactory: async (artifacts: ArtifactsService) => {
        const dbConfig = sessionGatewayEnvironment(process.env);
        const store = orchestrationStore(dbConfig);
        const conversationConfig = loadConversationManagerEnvironment(
          process.env,
        );
        const modelGateway = new ModelGatewayClient({
          address: conversationConfig.modelGatewayAddress,
          protoPath: MODELGW_CLIENT_PROTO_PATH,
          accessTokenProvider: internalM2mTokenProvider(),
        });
        const nodeexecConfig = loadNodeexecEnvironment(process.env);
        const toolGateway = new ToolGatewayClient({
          address: nodeexecConfig.toolGatewayAddress,
          protoPath: TOOLGW_CLIENT_PROTO_PATH,
          accessTokenProvider: internalM2mTokenProvider(),
        });
        const sandboxService = new SandboxServiceClient({
          address: nodeexecConfig.sandboxServiceAddress,
          protoPath: SANDBOX_CLIENT_PROTO_PATH,
          accessTokenProvider: internalM2mTokenProvider(),
        });
        const memoryService = new MemoryServiceClient({
          address: nodeexecConfig.memoryServiceAddress,
          protoPath: MEMORY_CLIENT_PROTO_PATH,
          authorization: nodeexecConfig.memoryServiceAuthorization,
        });
        const verifyGate = new VerifyGateService(
          new VerifyServiceClient({
            address: nodeexecConfig.verifyServiceAddress,
            protoPath: VERIFY_CLIENT_PROTO_PATH,
            // VerifyServiceClient sends this header verbatim, the same way the
            // memory client does. verification-service reads the token only
            // after a "Bearer " prefix and treats anything else as no
            // credential at all, so passing the bare token authenticated
            // nothing and every node scored through this client was rejected.
            authorization: `Bearer ${process.env["INTERNAL_SERVICE_TOKEN"] ?? ""}`,
          }),
        );
        // No real QueueProvider adapter exists yet -- PubSubHandler uses
        // the shared-clients mock here, same disclosed gap as EXEC-1.
        const queueProvider = createMockQueueProvider();
        // HumanApprovalHandler needs only createPending's capability, under
        // its own narrower method name -- a thin adapter over a full
        // ApprovalsService instance built the same way every other factory
        // here builds its own store/provider, never reaching into another
        // factory's closure.
        const runLauncherConfig = loadRunLauncherEnvironment(process.env);
        const approvalsService = new ApprovalsService(
          store,
          new TemporalDurableExecutionProvider({
            address: runLauncherConfig.temporalAddress,
            namespace: runLauncherConfig.temporalNamespace,
            taskQueue: runLauncherConfig.taskQueue,
            ...(runLauncherConfig.temporalApiKey === undefined
              ? {}
              : { apiKey: runLauncherConfig.temporalApiKey }),
          }),
        );
        const registry = createRuntimeNodeHandlerRegistry({
          modelGateway,
          memoryService,
          toolGateway,
          sandboxService,
          queueProvider,
          approvalRequester: {
            requestApproval: async (request) => {
              const created = await approvalsService.createPending(request);
              return { approvalId: created.id, expiryAt: created.expiryAt };
            },
          },
          verificationGateReader: new PostgresVerificationGateReader(store),
        });
        const ledger = new NodeExecutionLedgerService(store);
        const recoveryPolicy = buildRecoveryPolicyService();
        const recoveryTrigger = new RecoveryTriggerService(recoveryPolicy, recoveryPolicy);
        // Selection & Binding for LLMTask execution -- same Capability
        // Resolver gRPC target and intelligence-service FastAPI base URL
        // buildRecoveryPolicyService's swap_agent wiring already targets,
        // fresh instances per this factory's own no-shared-instances
        // convention. runWorkspaceLookup reuses this factory's own `store`,
        // same as the RUNS_HANDLER factory's own lookup below.
        const bindingConfig = loadRecoveryEnvironment(process.env);
        const capabilityResolverForNodeexec = new CapabilityServiceClient({
          address: bindingConfig.capabilityResolverAddress,
          protoPath: CAPABILITY_CLIENT_PROTO_PATH,
          authorization: process.env["INTERNAL_SERVICE_TOKEN"] ?? "",
        });
        const selectionBindingForNodeexec = new SelectionBindingClient({
          baseUrl: bindingConfig.plannerBaseUrl,
        });
        // performance_records writer -- same intelligence-service FastAPI
        // app Selection & Binding above already targets, just a different
        // route prefix.
        const performanceRecorder = new PerformanceRecorderClient({
          baseUrl: bindingConfig.plannerBaseUrl,
        });
        const runWorkspaceLookup = new RunWorkspaceLookupService(store);
        const selectionBindingFailClosed = new SsmSelectionBindingFailClosedConfig(
          new AwsSsmParameterProvider({ region: dbConfig.awsRegion }),
          dbConfig.selectionBindingFailClosedParameter,
        );
        const runFinalizationMemoryWriter = new PostgresRunFinalizationMemoryWriter(
          store,
          new PostgresVerificationGateReader(store),
          artifacts,
          memoryService,
        );
        return new NodeexecService(
          registry,
          ledger,
          new RunStreamEventService(store),
          recoveryTrigger,
          buildRunOutcomeService(),
          new ProjectRunProvisioningService(
            store,
            new ProvisioningClient({
              address: runLauncherConfig.provisioningServiceAddress,
              protoPath: PROVISIONING_CLIENT_PROTO_PATH,
              accessTokenProvider: internalM2mTokenProvider(),
            }),
          ),
          new GeneratedFileMaterializer(artifacts, sandboxService),
          verifyGate,
          runWorkspaceLookup,
          capabilityResolverForNodeexec,
          selectionBindingForNodeexec,
          performanceRecorder,
          selectionBindingFailClosed,
          runFinalizationMemoryWriter,
          new PostgresRunAcceptanceCheck(store, verifyGate, ledger),
        );
      },
      inject: [ArtifactsService],
    },
    {
      provide: RECOVERY_HANDLER,
      useFactory: () => buildRecoveryPolicyService(),
    },
    {
      provide: RUNS_HANDLER,
      useFactory: () => {
        // Own store instance, same reasoning as every other factory here
        // (see the ApprovalsService comment below): not maximally
        // efficient, but correct and isolated.
        const dbConfig = sessionGatewayEnvironment(process.env);
        const store = orchestrationStore(dbConfig);
        const lookup = new RunWorkspaceLookupService(store);
        return {
          getRunWorkspace: async (request: { tenant_id: string; run_id: string }) => {
            const run = await lookup.getRunWorkspace(request.tenant_id, request.run_id);
            return { workspace_id: run.workspaceId, workflow_id: run.workflowId };
          },
          getNodeExecutionRecoveryInfo: async (request: {
            tenant_id: string;
            run_id: string;
            node_execution_id: string;
          }) => {
            const info = await lookup.getRecoveryInfo(
              request.tenant_id,
              request.run_id,
              request.node_execution_id,
            );
            return { is_retry: info.isRetry, is_recovery: info.isRecovery };
          },
        };
      },
    },
    {
      provide: NodeExecutionLedgerService,
      useFactory: () => {
        const dbConfig = sessionGatewayEnvironment(process.env);
        const store = orchestrationStore(dbConfig);
        return new NodeExecutionLedgerService(store);
      },
    },
    {
      provide: RunStreamEventService,
      useFactory: () => {
        const dbConfig = sessionGatewayEnvironment(process.env);
        return new RunStreamEventService(orchestrationStore(dbConfig));
      },
    },
    {
      provide: RunObservabilityService,
      useFactory: () => {
        const dbConfig = sessionGatewayEnvironment(process.env);
        return new RunObservabilityService(orchestrationStore(dbConfig));
      },
    },
    {
      provide: RunOutcomeService,
      useFactory: () => buildRunOutcomeService(),
    },
    {
      provide: RUN_LEARNING_AUDIT,
      useFactory: () => runLearningAuditClient(process.env),
    },
    {
      provide: ApprovalsService,
      useFactory: () => {
        const dbConfig = sessionGatewayEnvironment(process.env);
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
        return new ApprovalsService(store, durable);
      },
    },
    {
      provide: EscalationsService,
      useFactory: () => {
        const dbConfig = sessionGatewayEnvironment(process.env);
        const store = orchestrationStore(dbConfig);
        // Same provider ApprovalsService takes above: resolving an
        // escalation that parked a run has to reach that run's workflow.
        const runLauncherConfig = loadRunLauncherEnvironment(process.env);
        const durable = new TemporalDurableExecutionProvider({
          address: runLauncherConfig.temporalAddress,
          namespace: runLauncherConfig.temporalNamespace,
          taskQueue: runLauncherConfig.taskQueue,
          ...(runLauncherConfig.temporalApiKey === undefined
            ? {}
            : { apiKey: runLauncherConfig.temporalApiKey }),
        });
        return new EscalationsService(store, durable);
      },
    },
    {
      provide: BLACKBOARD_HANDLER,
      useFactory: () => {
        const dbConfig = sessionGatewayEnvironment(process.env);
        const store = orchestrationStore(dbConfig);
        const cache = new RedisCacheProvider(
          parseRedisHostPort(dbConfig.redisUrl),
        );
        const blackboard = new BlackboardService(store, cache);
        return new BlackboardGrpcService(blackboard);
      },
    },
  ],
})
export class ExecutionRuntimeModule {}
