import { Module, type DynamicModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import {
  SsrfGuardedFetcher,
  TOOLGW_HANDLER,
  ToolgwGrpcController,
  type BrowserAutomationProvider,
  type DatabaseOperationProvider,
} from "@alterx/adapters";
import { M2mValidator, ServiceAuthGuard } from "@alterx/auth";
import type {
  AuditEventHandler,
  CacheProvider,
  ConfigProvider,
  EmailProvider,
  QueueProvider,
  SearchProvider,
  SecretsProvider,
} from "@alterx/shared-clients";

import { ToolGatewayService, type ToolGatewayServiceOptions } from "./gateway/tool-gateway.service";
import { HealthController } from "./health/health.controller";

@Module({})
export class AppModule {
  static register(
    configProvider: ConfigProvider,
    secretsProvider: SecretsProvider,
    searchProvider: SearchProvider,
    urlFetcher: SsrfGuardedFetcher,
    auditClient: AuditEventHandler,
    databaseProvider: DatabaseOperationProvider,
    costQueue: QueueProvider,
    costEventsQueueName: string,
    cacheProvider: CacheProvider,
    browserProvider: BrowserAutomationProvider,
    emailProvider: EmailProvider,
    options: ToolGatewayServiceOptions = {},
  ): DynamicModule {
    return {
      module: AppModule,
      controllers: [ToolgwGrpcController, HealthController],
      providers: [
        serviceAuthGuardProvider(),
        {
          provide: TOOLGW_HANDLER,
          useValue: new ToolGatewayService(
            configProvider,
            secretsProvider,
            searchProvider,
            urlFetcher,
            auditClient,
            databaseProvider,
            costQueue,
            costEventsQueueName,
            cacheProvider,
            browserProvider,
            emailProvider,
            options,
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
