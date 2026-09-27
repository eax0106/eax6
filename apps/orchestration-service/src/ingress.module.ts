import { Module } from "@nestjs/common";
import {
  AwsSecretsManagerProvider,
  ConversationDispatchClient,
  EventBridgeEventPublisher,
  RUNS_DISPATCH_HANDLER,
  RunDispatchGrpcController,
  TemporalDurableExecutionProvider,
} from "@alterx/adapters";

import { TriggerRegistryController } from "./trigger-registry/trigger-registry.controller";
import { TriggerRegistryService } from "./trigger-registry/trigger-registry.service";
import { TriggerEventDispatchService } from "./trigger-registry/trigger-event-dispatch.service";
import { EventController } from "./trigger-registry/event.controller";
import { EventQueryService } from "./trigger-registry/event-query.service";
import { loadTriggerDispatchEnvironment } from "./config/trigger-dispatch-environment";
import {
  IntegrationWebhookController,
  PostgresTriggerBindingStore,
  TriggerBindingController,
  TriggerBindingService,
  WebhookEndpointController,
  loadTriggerBindingEnvironment,
} from "./trigger-bindings";
import { loadRunLauncherEnvironment } from "./config/run-launcher-environment";
import { ConversationDispatchService } from "./webhooks/conversation-dispatch.service";
import { WhatsappWebhookController } from "./webhooks/whatsapp-webhook.controller";
import { WhatsappWebhookService } from "./webhooks/whatsapp-webhook.service";
import { WhatsappAccountRegistryService } from "./webhooks/whatsapp-account-registry.service";
import { WhatsappAccountsController } from "./webhooks/whatsapp-accounts.controller";
import { loadConversationDispatchEnvironment } from "./config/conversation-dispatch-environment";
import { loadWhatsappWebhookEnvironment } from "./config/whatsapp-webhook-environment";
import { RunLauncherService } from "./runs/run-launcher.service";
import {
  OrchestrationInfrastructureModule,
  orchestrationStore,
  sessionGatewayEnvironment,
} from "./orchestration-infrastructure.module";
import { RunLauncherModule } from "./run-launcher.module";

@Module({
  imports: [OrchestrationInfrastructureModule, RunLauncherModule],
  controllers: [
    TriggerRegistryController,
    TriggerBindingController,
    WebhookEndpointController,
    IntegrationWebhookController,
    RunDispatchGrpcController,
    WhatsappWebhookController,
    WhatsappAccountsController,
    EventController,
  ],
  providers: [
    {
      provide: EventQueryService,
      useFactory: () => {
        const dbConfig = sessionGatewayEnvironment(process.env);
        return new EventQueryService(orchestrationStore(dbConfig));
      },
    },
    {
      provide: WhatsappAccountRegistryService,
      useFactory: () => {
        const dbConfig = sessionGatewayEnvironment(process.env);
        return new WhatsappAccountRegistryService(orchestrationStore(dbConfig));
      },
    },
    {
      provide: TriggerRegistryService,
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
        // INGR-7: the same Temporal provider also owns cron trigger
        // Schedules. Its metadata claims the primary canonical interface
        // (DurableExecutionProvider); the CronScheduleManager capability
        // rides along structurally, so this is a boundary cast.
        return new TriggerRegistryService(
          store,
          undefined,
          durable as unknown as import("@alterx/shared-clients").CronScheduleManager,
        );
      },
    },
    {
      // Signing secrets are held by AWS Secrets Manager, the only
      // MutableSecretsProvider wired in this repo. Nothing about the
      // feature depends on that choice -- TriggerBindingService takes the
      // interface, so swapping in another provider is a one-line change.
      provide: TriggerBindingService,
      useFactory: () => {
        const dbConfig = sessionGatewayEnvironment(process.env);
        const store = orchestrationStore(dbConfig);
        const bindingConfig = loadTriggerBindingEnvironment(process.env);
        const dispatchConfig = loadTriggerDispatchEnvironment(process.env);
        return new TriggerBindingService(
          new PostgresTriggerBindingStore(store),
          new AwsSecretsManagerProvider({ region: dbConfig.awsRegion }),
          {
            webhookBaseUrl: bindingConfig.webhookBaseUrl,
            maxSkewSeconds: bindingConfig.maxSkewSeconds,
          },
          new EventBridgeEventPublisher({
            region: dbConfig.awsRegion,
            busName: dispatchConfig.eventBridgeBusName,
            ...(dispatchConfig.eventBridgeEndpoint === undefined
              ? {}
              : { endpoint: dispatchConfig.eventBridgeEndpoint }),
          }),
        );
      },
    },
    {
      provide: RUNS_DISPATCH_HANDLER,
      inject: [RunLauncherService],
      useFactory: (launcher: RunLauncherService) => {
        const dbConfig = sessionGatewayEnvironment(process.env);
        const store = orchestrationStore(dbConfig);
        return new TriggerEventDispatchService(store, launcher);
      },
    },
    {
      provide: WhatsappWebhookService,
      useFactory: () => {
        const dbConfig = sessionGatewayEnvironment(process.env);
        const store = orchestrationStore(dbConfig);
        const whatsappConfig = loadWhatsappWebhookEnvironment(process.env);
        return new WhatsappWebhookService(
          store,
          whatsappConfig,
          undefined,
          new WhatsappAccountRegistryService(store),
        );
      },
    },
    {
      provide: ConversationDispatchService,
      useFactory: () => {
        const dbConfig = sessionGatewayEnvironment(process.env);
        const store = orchestrationStore(dbConfig);
        const dispatchConfig = loadConversationDispatchEnvironment(process.env);
        const dispatchClient = new ConversationDispatchClient({
          address: dispatchConfig.temporalAddress,
          namespace: dispatchConfig.temporalNamespace,
          taskQueue: dispatchConfig.taskQueue,
          ...(dispatchConfig.temporalApiKey === undefined
            ? {}
            : { apiKey: dispatchConfig.temporalApiKey }),
        });
        return new ConversationDispatchService(store, dispatchClient, {
          taskQueue: dispatchConfig.taskQueue,
          idleTimeoutSeconds: dispatchConfig.idleTimeoutSeconds,
          historyRolloverEventCount:
            dispatchConfig.historyRolloverEventCount,
        });
      },
    },
  ],
})
export class IngressModule {}
