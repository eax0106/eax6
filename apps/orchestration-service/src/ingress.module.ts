import { Module } from "@nestjs/common";
import { EngineBillingAccountService } from "./billing/billing-account.service";
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
import { loadPublicFormLinkEnvironment } from "./config/public-form-environment";
import { TriggerEventDispatchService } from "./trigger-registry/trigger-event-dispatch.service";
import { EventController } from "./trigger-registry/event.controller";
import { EventQueryService } from "./trigger-registry/event-query.service";
import { EventReplayService } from "./trigger-registry/event-replay.service";
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
  buildRunBudgetGate,
  OrchestrationInfrastructureModule,
  orchestrationStore,
  identityTenantGatewayEnvironment,
} from "./orchestration-infrastructure.module";
import { RunLauncherModule } from "./run-launcher.module";
import { EmailDeliveryFailuresController, SesDeliveryEventsController } from "./webhooks/ses-delivery-events.controller";
import { SesDeliveryEventsService } from "./webhooks/ses-delivery-events.service";
import { RunStreamEventService } from "./runs/run-stream-event.service";
import { loadSesDeliveryEnvironment, SES_DELIVERY_ENVIRONMENT } from "./config/ses-delivery-environment";

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
    SesDeliveryEventsController,
    EmailDeliveryFailuresController,
  ],
  providers: [
    {
      provide: EventReplayService,
      inject: [RunLauncherService],
      useFactory: (launcher: RunLauncherService) => new EventReplayService(
        orchestrationStore(identityTenantGatewayEnvironment(process.env)), launcher),
    },
    {
      provide: SesDeliveryEventsService,
      useFactory: () => {
        const store = orchestrationStore(identityTenantGatewayEnvironment(process.env));
        return new SesDeliveryEventsService(
          store,
          new RunStreamEventService(store),
        );
      },
    },
    {
      provide: SES_DELIVERY_ENVIRONMENT,
      useFactory: () => loadSesDeliveryEnvironment(process.env),
    },
    {
      provide: EventQueryService,
      useFactory: () => {
        const dbConfig = identityTenantGatewayEnvironment(process.env);
        return new EventQueryService(orchestrationStore(dbConfig));
      },
    },
    {
      provide: WhatsappAccountRegistryService,
      useFactory: () => {
        const dbConfig = identityTenantGatewayEnvironment(process.env);
        return new WhatsappAccountRegistryService(orchestrationStore(dbConfig));
      },
    },
    {
      provide: TriggerRegistryService,
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
        // INGR-7: the same Temporal provider also owns cron trigger
        // Schedules. Its metadata claims the primary canonical interface
        // (DurableExecutionProvider); the CronScheduleManager capability
        // rides along structurally, so this is a boundary cast.
        return new TriggerRegistryService(
          store,
          undefined,
          durable as unknown as import("@alterx/shared-clients").CronScheduleManager,
          loadPublicFormLinkEnvironment(),
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
        const dbConfig = identityTenantGatewayEnvironment(process.env);
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
        const dbConfig = identityTenantGatewayEnvironment(process.env);
        const store = orchestrationStore(dbConfig);
        return new TriggerEventDispatchService(store, launcher, buildRunBudgetGate(process.env), new EngineBillingAccountService(store));
      },
    },
    {
      provide: WhatsappWebhookService,
      useFactory: () => {
        const dbConfig = identityTenantGatewayEnvironment(process.env);
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
        const dbConfig = identityTenantGatewayEnvironment(process.env);
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
