import { Module } from "@nestjs/common";
import { BillingAccountController, BILLING_SYNC_TOKEN_HASH } from "./billing/billing-account.controller";
import { EngineBillingAccountService } from "./billing/billing-account.service";
import { AwsSecretsManagerProvider, EvalServiceClient } from "@alterx/adapters";
import { loadServiceTokenFingerprint } from "./config/service-token-fingerprint";

import {
  DEPLOYMENT_ADMIN_TOKEN_HASH,
  DeploymentAdminController,
} from "./deployment-admin/deployment-admin.controller";
import { DeploymentAdminService } from "./deployment-admin/deployment-admin.service";
import {
  DeletionController,
  ORCHESTRATION_DELETION_TOKEN_HASH,
} from "./deletion/deletion.controller";
import { OrchestrationDeletionService } from "./deletion/deletion.service";
import { ConnectionRegistryController, CONNECTION_LOOKUP_TOKEN_HASH, CONNECTION_REGISTRY_TOKEN_HASH } from "./connections/connection-registry.controller";
import { ConnectionRegistryService } from "./connections/connection-registry.service";
import { DeletionRequestController } from "./deletion/deletion-request.controller";
import {
  EVAL_FACADE_CONFIG,
  loadEvalFacadeEnvironment,
  type EvalFacadeEnvironment,
} from "./eval-facade/config";
import {
  EvalFacadeController,
  EVAL_FACADE_TOKEN_HASH,
} from "./eval-facade/eval-facade.controller";
import { EvalFacadeService } from "./eval-facade/eval-facade.service";
import { EVAL_PROTO_PATH } from "./eval-facade/grpc.constants";
import {
  OrchestrationInfrastructureModule,
  orchestrationStore,
  identityTenantGatewayEnvironment,
} from "./orchestration-infrastructure.module";

@Module({
  imports: [OrchestrationInfrastructureModule],
  controllers: [
    DeletionController,
    DeletionRequestController,
    EvalFacadeController,
    DeploymentAdminController,
    ConnectionRegistryController,
    BillingAccountController,
  ],
  providers: [
    { provide: BILLING_SYNC_TOKEN_HASH, useFactory: () => loadServiceTokenFingerprint(process.env, "BILLING_SYNC_SERVICE_TOKEN_SHA256") },
    { provide: EngineBillingAccountService, useFactory: () => new EngineBillingAccountService(orchestrationStore(identityTenantGatewayEnvironment(process.env))) },
    {
      provide: CONNECTION_LOOKUP_TOKEN_HASH,
      useFactory: () => loadServiceTokenFingerprint(process.env, "INTERNAL_SERVICE_TOKEN_SHA256"),
    },
    {
      provide: CONNECTION_REGISTRY_TOKEN_HASH,
      useFactory: () => loadServiceTokenFingerprint(process.env, "CONNECTION_REGISTRY_SERVICE_TOKEN_SHA256"),
    },
    {
      provide: ConnectionRegistryService,
      useFactory: () => new ConnectionRegistryService(orchestrationStore(identityTenantGatewayEnvironment(process.env))),
    },
    {
      provide: EVAL_FACADE_CONFIG,
      useFactory: () => loadEvalFacadeEnvironment(process.env),
    },
    {
      provide: EVAL_FACADE_TOKEN_HASH,
      inject: [EVAL_FACADE_CONFIG],
      useFactory: (config: EvalFacadeEnvironment) => config.tokenHash,
    },
    {
      provide: EvalServiceClient,
      inject: [EVAL_FACADE_CONFIG],
      useFactory: (config: EvalFacadeEnvironment) => new EvalServiceClient({
        address: config.grpcTarget,
        protoPath: EVAL_PROTO_PATH,
        // Sent verbatim by EvalServiceClient, and eval-service reads the token
        // only after a "Bearer " prefix -- the same requirement
        // verification-service has, and the same reason a bare token here
        // authenticated nothing.
        authorization: `Bearer ${process.env["INTERNAL_SERVICE_TOKEN"] ?? ""}`,
      }),
    },
    EvalFacadeService,
    {
      provide: DEPLOYMENT_ADMIN_TOKEN_HASH,
      useFactory: () => loadServiceTokenFingerprint(
        process.env,
        "DEPLOYMENT_ADMIN_SERVICE_TOKEN_SHA256",
      ),
    },
    {
      provide: DeploymentAdminService,
      useFactory: () => {
        const dbConfig = identityTenantGatewayEnvironment(process.env);
        return new DeploymentAdminService(orchestrationStore(dbConfig));
      },
    },
    {
      provide: ORCHESTRATION_DELETION_TOKEN_HASH,
      useFactory: () => loadServiceTokenFingerprint(
        process.env,
        "DELETION_SERVICE_TOKEN_SHA256",
      ),
    },
    {
      provide: OrchestrationDeletionService,
      useFactory: () => {
        const dbConfig = identityTenantGatewayEnvironment(process.env);
        const tenantStore = orchestrationStore(dbConfig);
        const deletionDatabaseUser = process.env.DELETION_DATABASE_USER?.trim();
        if (deletionDatabaseUser === undefined || deletionDatabaseUser.length === 0) {
          throw new Error("DELETION_DATABASE_USER is required for internal deletion sweeps");
        }
        const systemStore = orchestrationStore(dbConfig, deletionDatabaseUser);
        // Webhook signing secrets live in AWS Secrets Manager (see ingress.module.ts).
        return new OrchestrationDeletionService(
          tenantStore,
          systemStore,
          new AwsSecretsManagerProvider({ region: dbConfig.awsRegion }),
        );
      },
    },
  ],
  exports: [EvalFacadeService, ConnectionRegistryService],
})
export class OperationsModule {}
