import { Module } from "@nestjs/common";
import { AwsSecretsManagerProvider, EvalServiceClient } from "@alterx/adapters";

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
  sessionGatewayEnvironment,
} from "./orchestration-infrastructure.module";

/**
 * Requires a 64-char hex SHA-256 fingerprint from the named env var --
 * shared by DEPLOYMENT_ADMIN_TOKEN_HASH and ORCHESTRATION_DELETION_TOKEN_HASH
 * below, the only two callers left after this module's extraction.
 */
function requireSha256Fingerprint(value: string | undefined, field: string): string {
  const normalized = value?.trim() ?? "";
  if (!/^[0-9a-f]{64}$/i.test(normalized)) {
    throw new Error(`${field} must be a 64-character SHA-256 fingerprint`);
  }
  return normalized;
}

@Module({
  imports: [OrchestrationInfrastructureModule],
  controllers: [
    DeletionController,
    DeletionRequestController,
    EvalFacadeController,
    DeploymentAdminController,
  ],
  providers: [
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
      useFactory: () => requireSha256Fingerprint(
        process.env.DEPLOYMENT_ADMIN_SERVICE_TOKEN_SHA256,
        "DEPLOYMENT_ADMIN_SERVICE_TOKEN_SHA256",
      ),
    },
    {
      provide: DeploymentAdminService,
      useFactory: () => {
        const dbConfig = sessionGatewayEnvironment(process.env);
        return new DeploymentAdminService(orchestrationStore(dbConfig));
      },
    },
    {
      provide: ORCHESTRATION_DELETION_TOKEN_HASH,
      useFactory: () => requireSha256Fingerprint(
        process.env.DELETION_SERVICE_TOKEN_SHA256,
        "DELETION_SERVICE_TOKEN_SHA256",
      ),
    },
    {
      provide: OrchestrationDeletionService,
      useFactory: () => {
        const dbConfig = sessionGatewayEnvironment(process.env);
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
  exports: [EvalFacadeService],
})
export class OperationsModule {}
