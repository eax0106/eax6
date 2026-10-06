import { Module, type DynamicModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { MODELGW_HANDLER, ModelgwGrpcController } from "@alterx/adapters";
import { M2mValidator, ServiceAuthGuard } from "@alterx/auth";
import type {
  CacheProvider,
  EmbeddingProvider,
  PIIRedactionProvider,
  QueueProvider,
} from "@alterx/shared-clients";

import { ModelGatewayService } from "./gateway/model-gateway.service";
import { HealthController } from "./health/health.controller";
import {
  MODEL_GATEWAY_ADMIN_TOKEN,
  ModelGatewayOperationsController,
} from "./operations/model-gateway-operations.controller";
import { OperationalConfigProvider } from "./operations/operational-config-provider";
import { FailoverModelProvider, type CostHandlerClient } from "@alterx/adapters";
import type { LocalSmokeBudget } from "./gateway/local-smoke-budget";

@Module({})
export class AppModule {
  static register(
    configProvider: OperationalConfigProvider,
    modelProvider: FailoverModelProvider,
    piiRedactionProvider: PIIRedactionProvider,
    embeddingProvider: EmbeddingProvider,
    cacheProvider: CacheProvider,
    queueProvider: QueueProvider,
    costEventsQueueName: string,
    adminServiceToken: string,
    costClient: CostHandlerClient,
    localSmokeBudget?: LocalSmokeBudget,
  ): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        ModelgwGrpcController,
        HealthController,
        ModelGatewayOperationsController,
      ],
      providers: [
        serviceAuthGuardProvider(),
        { provide: OperationalConfigProvider, useValue: configProvider },
        { provide: FailoverModelProvider, useValue: modelProvider },
        { provide: MODEL_GATEWAY_ADMIN_TOKEN, useValue: adminServiceToken },
        {
          provide: MODELGW_HANDLER,
          useValue: new ModelGatewayService(
            configProvider,
            modelProvider,
            piiRedactionProvider,
            embeddingProvider,
            cacheProvider,
            queueProvider,
            costEventsQueueName,
            costClient,
            localSmokeBudget,
          ),
        },
      ],
    };
  }
}

function serviceAuthGuardProvider() {
  return {
    provide: APP_GUARD,
    useFactory: () =>
      new ServiceAuthGuard(
        new M2mValidator({
          auth0Domain: process.env["AUTH0_DOMAIN"] ?? "",
          apiAudience: process.env["API_AUDIENCE"] ?? "",
          ...(process.env["AUTH0_JWKS_URL"] === undefined
            ? {}
            : { jwksUrl: process.env["AUTH0_JWKS_URL"] }),
        }),
      ),
  };
}
