import { Module, type DynamicModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { AuditGrpcController } from "@alterx/adapters";
import { M2mValidator, ServiceAuthGuard } from "@alterx/auth";
import {
  AUDIT_EVENT_HANDLER,
  AUDIT_STORE_PROVIDER,
  type AuditStoreProvider,
} from "@alterx/shared-clients";

import { AuditService } from "./audit/audit.service";
import { AuditStoreLifecycle } from "./database/store.lifecycle";
import { HealthController } from "./health/health.controller";
import type { ObjectStorageProvider } from "@alterx/shared-clients";
import { DELETION_SERVICE_TOKEN_HASH, DeletionController } from "./deletion/deletion.controller";
import { DeletionOrchestrator } from "./deletion/deletion-orchestrator";
import { HttpDeletionProvider } from "./deletion/http-deletion-provider";
import { AUDIT_QUERY_SERVICE_TOKEN_HASH, AuditQueryController } from "./audit/audit-query.controller";

export interface AuditDeletionWiring {
  readonly adsBaseUrl: string;
  readonly orchestrationBaseUrl: string;
  readonly platformApiBaseUrl: string;
  readonly serviceToken: string;
  readonly serviceTokenHash: string;
  readonly pseudonymKey: string;
  readonly objectStorage: ObjectStorageProvider;
}

@Module({})
export class AppModule {
  static register(store: AuditStoreProvider, deletion?: AuditDeletionWiring): DynamicModule {
    const orchestrator = deletion === undefined ? undefined : new DeletionOrchestrator(
      store,
      [new HttpDeletionProvider(deletion.adsBaseUrl, deletion.serviceToken, "ads-core"),
       new HttpDeletionProvider(deletion.orchestrationBaseUrl, deletion.serviceToken, "orchestration-service"),
       new HttpDeletionProvider(deletion.platformApiBaseUrl, deletion.serviceToken, "platform-api")],
      deletion.objectStorage,
      deletion.pseudonymKey,
    );
    return {
      module: AppModule,
      controllers: [
        AuditGrpcController,
        HealthController,
        ...(deletion === undefined ? [] : [DeletionController, AuditQueryController]),
      ],
      providers: [
        serviceAuthGuardProvider(),
        { provide: AUDIT_STORE_PROVIDER, useValue: store },
        AuditService,
        { provide: AUDIT_EVENT_HANDLER, useExisting: AuditService },
        AuditStoreLifecycle,
        ...(orchestrator === undefined || deletion === undefined ? [] : [
          { provide: DeletionOrchestrator, useValue: orchestrator },
          { provide: DELETION_SERVICE_TOKEN_HASH, useValue: deletion.serviceTokenHash },
          // Reuses the same internal service token as deletion -- both are
          // the identical trust boundary (trusted platform-api caller),
          // no reason to sprawl a second secret for the same relationship.
          { provide: AUDIT_QUERY_SERVICE_TOKEN_HASH, useValue: deletion.serviceTokenHash },
        ]),
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
