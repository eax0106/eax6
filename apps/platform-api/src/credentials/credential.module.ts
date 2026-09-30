import { Module } from "@nestjs/common";
import { AwsSecretsManagerProvider } from "@alterx/adapters";
import { engineAuditClientFromEnvironment } from "../audit/engine-audit-client";
import { sharedPool } from "../db/shared-pool";
import {
  ConcurrencyExceptionFilter,
  ETAG_RESOURCE_RESOLVER,
  EtagResponseInterceptor,
  IfMatchGuard,
} from "../concurrency";
import { IdempotencyModule } from "../idempotency";
import { EngineModule } from "../engine/engine.module";
import { CredentialController } from "./credential.controller";
import { CredentialResumeController } from "./credential-resume.controller";
import { CredentialEtagResolver } from "./credential-etag.resolver";
import { CredentialExceptionFilter } from "./credential-exception.filter";
import { CredentialRepository } from "./credential.repository";
import { CredentialService } from "./credential.service";
import { CREDENTIAL_AUDIT_CLIENT, CREDENTIAL_SECRETS_PROVIDER } from "./tokens";

@Module({
  imports: [IdempotencyModule, EngineModule],
  controllers: [CredentialController, CredentialResumeController],
  providers: [
    {
      provide: CredentialRepository,
      useFactory: () => new CredentialRepository(sharedPool(process.env.DATABASE_URL), false),
    },
    {
      provide: CREDENTIAL_SECRETS_PROVIDER,
      useFactory: () =>
        new AwsSecretsManagerProvider({
          region: process.env.AWS_REGION ?? "ap-south-1",
        }),
    },
    {
      provide: CREDENTIAL_AUDIT_CLIENT,
      useFactory: engineAuditClientFromEnvironment,
    },
    CredentialService,
    CredentialEtagResolver,
    {
      provide: ETAG_RESOURCE_RESOLVER,
      useExisting: CredentialEtagResolver,
    },
    IfMatchGuard,
    EtagResponseInterceptor,
    ConcurrencyExceptionFilter,
    CredentialExceptionFilter,
  ],
  exports: [CredentialService, CREDENTIAL_SECRETS_PROVIDER],
})
export class CredentialModule {}
