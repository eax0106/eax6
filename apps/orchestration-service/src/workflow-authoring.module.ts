import { Module } from "@nestjs/common";
import {
  COMPILER_HANDLER,
  CompilerGrpcController,
  CONVERSATION_HANDLER,
  ConversationGrpcController,
  DEPLOYCTL_HANDLER,
  DeployctlGrpcController,
  AwsSsmParameterProvider,
  ModelGatewayClient,
  PlannerClient,
  S3ObjectStorageProvider,
  createFetchSelectionBindingHttpClient,
} from "@alterx/adapters";

import { MODELGW_CLIENT_PROTO_PATH } from "./conversation/grpc.constants";
import { ConversationManagerService } from "./conversation/conversation-manager.service";
import { GraphCompilerService } from "./compiler/graph-compiler.service";
import { WorkflowLifecycleService } from "./workflow-lifecycle/workflow-lifecycle.service";
import { WorkflowDeploymentController } from "./workflow-lifecycle/workflow-deployment.controller";
import { WorkflowChatController } from "./workflow-chat/workflow-chat.controller";
import { WorkflowChatService } from "./workflow-chat/workflow-chat.service";
import { WorkflowTemplatesController } from "./workflow-templates/workflow-templates.controller";
import { WorkflowTemplatesService } from "./workflow-templates/workflow-templates.service";
import { HttpWorkflowTemplateRegistry } from "./workflow-templates/template-registry.client";
import { WorkflowFoldersController } from "./workflow-folders/workflow-folders.controller";
import { WorkflowFoldersService } from "./workflow-folders/workflow-folders.service";
import { WorkflowReadController } from "./workflow-read/workflow-read.controller";
import { WorkflowReadService } from "./workflow-read/workflow-read.service";
import { WorkflowHealthService } from "./workflow-health/workflow-health.service";
import { TemplateVariablesController } from "./template-variables/template-variables.controller";
import { TemplateVariablesService } from "./template-variables/template-variables.service";
import { ClarificationsController } from "./clarifications/clarifications.controller";
import { ClarificationsService } from "./clarifications/clarifications.service";
import { ProjectReadController } from "./project-read/project-read.controller";
import { ProjectReadService } from "./project-read/project-read.service";
import { ProjectDomainService } from "./project-read/project-domain.service";
import { loadConversationManagerEnvironment, loadNodeOverrideThresholds } from "./config/environment";
import { NodeOverridesService } from "./node-overrides/node-overrides.service";
import { loadRecoveryEnvironment } from "./config/recovery-environment";
import { ArtifactsService } from "./artifacts/artifacts.service";
import { EvalFacadeService } from "./eval-facade/eval-facade.service";
import { RunLauncherService } from "./runs/run-launcher.service";
import {
  OrchestrationInfrastructureModule,
  internalM2mTokenProvider,
  orchestrationStore,
  identityTenantGatewayEnvironment,
  buildWorstCaseEstimator,
} from "./orchestration-infrastructure.module";
import { RunLauncherModule } from "./run-launcher.module";
import { ArtifactModule } from "./artifact.module";
import { OperationsModule } from "./operations.module";

@Module({
  imports: [
    OrchestrationInfrastructureModule,
    RunLauncherModule,
    ArtifactModule,
    OperationsModule,
  ],
  controllers: [
    ConversationGrpcController,
    CompilerGrpcController,
    DeployctlGrpcController,
    WorkflowReadController,
    WorkflowFoldersController,
    WorkflowChatController,
    WorkflowTemplatesController,
    WorkflowDeploymentController,
    TemplateVariablesController,
    ClarificationsController,
    ProjectReadController,
  ],
  providers: [
    {provide:NodeOverridesService,useFactory:()=>new NodeOverridesService(
      orchestrationStore(identityTenantGatewayEnvironment(process.env)),buildWorstCaseEstimator(process.env),
      createFetchSelectionBindingHttpClient(),loadRecoveryEnvironment(process.env).plannerBaseUrl,loadNodeOverrideThresholds(process.env),
    )},
    { provide: WorkflowFoldersService, useFactory: () => new WorkflowFoldersService(orchestrationStore(identityTenantGatewayEnvironment(process.env))) },
    { provide: WorkflowHealthService, useFactory: () => new WorkflowHealthService(orchestrationStore(identityTenantGatewayEnvironment(process.env))) },
    {
      provide: WorkflowChatService,
      useFactory: () => {
        const config = identityTenantGatewayEnvironment(process.env);
        const conversation = loadConversationManagerEnvironment(process.env);
        return new WorkflowChatService(orchestrationStore(config), new ModelGatewayClient({
          address: conversation.modelGatewayAddress, protoPath: MODELGW_CLIENT_PROTO_PATH, accessTokenProvider: internalM2mTokenProvider(),
        }));
      },
    },
    {
      // D18: templates are read from the Capability Registry in
      // intelligence-service, the same service the planner URL names.
      provide: WorkflowTemplatesService,
      inject: [WorkflowChatService],
      useFactory: (chats: WorkflowChatService) => new WorkflowTemplatesService(
        orchestrationStore(identityTenantGatewayEnvironment(process.env)),
        new HttpWorkflowTemplateRegistry(loadRecoveryEnvironment(process.env).plannerBaseUrl),
        chats,
        loadConversationManagerEnvironment(process.env).alterEnvironment,
      ),
    },
    {
      provide: CONVERSATION_HANDLER,
      useFactory: () => {
        const dbConfig = identityTenantGatewayEnvironment(process.env);
        const conversationConfig = loadConversationManagerEnvironment(process.env);
        const store = orchestrationStore(dbConfig);
        const modelGateway = new ModelGatewayClient({
          address: conversationConfig.modelGatewayAddress,
          protoPath: MODELGW_CLIENT_PROTO_PATH,
          accessTokenProvider: internalM2mTokenProvider(),
        });
        return new ConversationManagerService(store, modelGateway);
      },
    },
    {
      provide: WorkflowReadService,
      useFactory: () => {
        const dbConfig = identityTenantGatewayEnvironment(process.env);
        const store = orchestrationStore(dbConfig);
        return new WorkflowReadService(store);
      },
    },
    {
      provide: TemplateVariablesService,
      useFactory: () => {
        const dbConfig = identityTenantGatewayEnvironment(process.env);
        return new TemplateVariablesService(orchestrationStore(dbConfig));
      },
    },
    {
      provide: ClarificationsService,
      useFactory: () => {
        const dbConfig = identityTenantGatewayEnvironment(process.env);
        return new ClarificationsService(orchestrationStore(dbConfig));
      },
    },
    {
      provide: ProjectReadService,
      useFactory: () => {
        const dbConfig = identityTenantGatewayEnvironment(process.env);
        const store = orchestrationStore(dbConfig);
        return new ProjectReadService(store);
      },
    },
    {
      provide: ProjectDomainService,
      inject: [RunLauncherService, CONVERSATION_HANDLER],
      useFactory: (launcher: RunLauncherService, conversations: import("@alterx/adapters").ConversationHandler) => {
        const dbConfig = identityTenantGatewayEnvironment(process.env);
        const store = orchestrationStore(dbConfig);
        const recoveryConfig = loadRecoveryEnvironment(process.env);
        return new ProjectDomainService(
          store,
          new PlannerClient({ baseUrl: recoveryConfig.plannerBaseUrl }),
          conversations,
          launcher,
        );
      },
    },
    {
      provide: COMPILER_HANDLER,
      useFactory: () => {
        const dbConfig = identityTenantGatewayEnvironment(process.env);
        const store = orchestrationStore(dbConfig);
        return new GraphCompilerService(store);
      },
    },
    {
      provide: WorkflowLifecycleService,
      useFactory: async (artifacts: ArtifactsService, evalFacade: EvalFacadeService) => {
        const dbConfig = identityTenantGatewayEnvironment(process.env);
        const store = orchestrationStore(dbConfig);
        const parameterStore = new AwsSsmParameterProvider({
          region: dbConfig.awsRegion,
        });
        try {
          const staticDeploymentBucket = await parameterStore.getParameter(
            dbConfig.artifactsBucketParameter,
          );
          return new WorkflowLifecycleService(store, evalFacade, {
            artifacts,
            objects: new S3ObjectStorageProvider({ region: dbConfig.awsRegion }),
            staticDeploymentBucket,
          });
        } finally {
          parameterStore.close();
        }
      },
      inject: [ArtifactsService, EvalFacadeService],
    },
    {
      provide: DEPLOYCTL_HANDLER,
      useExisting: WorkflowLifecycleService,
    },
  ],
})
export class WorkflowAuthoringModule {}
