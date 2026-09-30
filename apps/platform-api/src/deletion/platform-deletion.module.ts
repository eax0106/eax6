import { createHash } from "node:crypto";
import { Module } from "@nestjs/common";
import type { MutableSecretsProvider } from "@alterx/shared-clients";
import { sharedPool } from "../db/shared-pool";
import { CREDENTIAL_SECRETS_PROVIDER } from "../credentials/tokens";
import { CredentialModule } from "../credentials/credential.module";
import { ENGINE_CONFIG, type EngineConfig } from "../engine";
import { EngineModule } from "../engine/engine.module";
import { resolveRuntimeSecret } from "../identity/identity.module";
import { PgErasureStore } from "./pg-erasure-store";
import { PLATFORM_DELETION_TOKEN_HASH, PlatformDeletionController } from "./platform-deletion.controller";
import { PlatformDeletionService } from "./platform-deletion.service";

/**
 * The erasure provider for platform_db (D2, C3b). The shared deletion service
 * token is the one platform-api already holds to call audit-service
 * (AUDIT_QUERY_SERVICE_TOKEN_REF; the production config check pins it to
 * audit-service's DELETION_SERVICE_TOKEN_REF), so no new secret is introduced.
 */
@Module({
  imports: [EngineModule, CredentialModule],
  controllers: [PlatformDeletionController],
  providers: [
    {
      provide: PlatformDeletionService,
      inject: [CREDENTIAL_SECRETS_PROVIDER],
      // The database URL comes through the runtime reference resolver, like the token below, so
      // this module reads no environment itself.
      useFactory: async (secrets: MutableSecretsProvider) =>
        new PlatformDeletionService(new PgErasureStore(sharedPool(await resolveRuntimeSecret("env:DATABASE_URL"))), secrets),
    },
    {
      provide: PLATFORM_DELETION_TOKEN_HASH,
      inject: [ENGINE_CONFIG, CREDENTIAL_SECRETS_PROVIDER],
      // Resolved on first use, so an unconfigured environment fails the route (401), not the boot of every service that builds the app.
      useFactory: (config: EngineConfig, secrets: MutableSecretsProvider) => {
        let hash: Promise<string> | undefined;
        return () =>
          (hash ??= (config.auditQueryServiceTokenRef.startsWith("env:")
            ? resolveRuntimeSecret(config.auditQueryServiceTokenRef)
            : secrets.getSecret(config.auditQueryServiceTokenRef)).then((token) =>
            createHash("sha256").update(token).digest("hex"),
          ));
      },
    },
  ],
})
export class PlatformDeletionModule {}
