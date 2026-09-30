import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { resolveRuntimeSecret } from "../identity/identity.module";
import { IdentityBrokerModule } from "../identity-broker/identity-broker.module";
import { IdentityBrokerService } from "../identity-broker/identity-broker.service";
import {
  Auth0EngineM2mTokenProvider,
  ENGINE_AUTH_PROVIDER,
  ENGINE_M2M_TOKEN_PROVIDER,
  IdentityBrokerEngineAuthProvider,
  type EngineM2mTokenProvider,
} from "./auth";
import { engineConfigFromEnvironment, type EngineConfig } from "./config";
import { ENGINE_CONFIG, EngineClient } from "./engine-client";
import { CostLedgerClient } from "./cost-ledger-client";
import { EvalFacadeClient } from "./eval-facade-client";
import { DeploymentAdminClient } from "./deployment-admin-client";
import { AuditEventsClient } from "./audit-events-client";
import { EngineExceptionFilter } from "./engine-exception.filter";
import { secretsProviderToken } from "../identity-broker/identity-broker.module";
import type { SecretsProvider } from "@alterx/shared-clients";

@Module({
  imports: [IdentityBrokerModule],
  providers: [
    {
      provide: ENGINE_CONFIG,
      useFactory: () => engineConfigFromEnvironment(process.env),
    },
    {
      provide: ENGINE_M2M_TOKEN_PROVIDER,
      inject: [ENGINE_CONFIG],
      useFactory: (config: EngineConfig): EngineM2mTokenProvider =>
        new Auth0EngineM2mTokenProvider({
          tokenUrl: config.m2mTokenUrl,
          audience: config.m2mAudience,
          clientId: config.m2mClientId,
          clientSecretRef: config.m2mClientSecretRef,
          resolveSecret: resolveRuntimeSecret,
        }),
    },
    {
      provide: ENGINE_AUTH_PROVIDER,
      inject: [IdentityBrokerService, ENGINE_M2M_TOKEN_PROVIDER],
      useFactory: (
        identityBroker: IdentityBrokerService,
        tokenProvider: EngineM2mTokenProvider,
      ) => new IdentityBrokerEngineAuthProvider(identityBroker, tokenProvider),
    },
    {
      provide: EngineClient,
      inject: [ENGINE_CONFIG, ENGINE_AUTH_PROVIDER],
      useFactory: (
        config: EngineConfig,
        authProvider: IdentityBrokerEngineAuthProvider,
      ) => new EngineClient(config, authProvider, fetch, undefined, resolveRuntimeSecret),
    },
    {
      provide: CostLedgerClient,
      inject: [ENGINE_CONFIG, ENGINE_AUTH_PROVIDER],
      useFactory: (
        config: EngineConfig,
        authProvider: IdentityBrokerEngineAuthProvider,
      ) => new CostLedgerClient(config, authProvider),
    },
    {
      provide: EvalFacadeClient,
      inject: [ENGINE_CONFIG],
      useFactory: (config: EngineConfig) =>
        new EvalFacadeClient(config, resolveRuntimeSecret),
    },
    {
      provide: DeploymentAdminClient,
      inject: [ENGINE_CONFIG],
      useFactory: (config: EngineConfig) =>
        new DeploymentAdminClient(config, resolveRuntimeSecret),
    },
    {
      provide: AuditEventsClient,
      inject: [ENGINE_CONFIG, secretsProviderToken],
      useFactory: (config: EngineConfig, secrets: SecretsProvider) =>
        new AuditEventsClient(config, secrets),
    },
    {
      provide: APP_FILTER,
      useClass: EngineExceptionFilter,
    },
  ],
  exports: [EngineClient, CostLedgerClient, EvalFacadeClient, DeploymentAdminClient, AuditEventsClient, ENGINE_M2M_TOKEN_PROVIDER, ENGINE_CONFIG],
})
export class EngineModule {}
