import { Module } from "@nestjs/common";
import type { AuditEventHandler } from "@alterx/shared-clients";
import { AdsModule } from "../ads";
import { engineAuditClientFromEnvironment } from "../audit/engine-audit-client";
import { EngineModule } from "../engine";
import { IdempotencyModule } from "../idempotency";
import { NotificationModule } from "../notifications/notification.module";
import { PlatformDb } from "../signup/platform-db";
import { SignupModule } from "../signup/signup.module";
import { WorkspaceExportRunner } from "./workspace-export.runner";
import { SystemNotificationStore } from "../notifications/system-notification-store";
import { EngineClient } from "../engine/engine-client";
import { AdsService } from "../ads/ads.service";
import { WorkspaceExportController } from "./workspace-export.controller";
import { WorkspaceExportTriggerController } from "./workspace-export-trigger.controller";
import { WorkspaceExportService } from "./workspace-export.service";

const WORKSPACE_EXPORT_AUDIT_CLIENT = Symbol("WORKSPACE_EXPORT_AUDIT_CLIENT");

@Module({
  imports: [SignupModule, EngineModule, AdsModule, NotificationModule, IdempotencyModule],
  controllers: [WorkspaceExportController, WorkspaceExportTriggerController],
  providers: [
    {
      provide: WorkspaceExportService,
      inject: [PlatformDb, WORKSPACE_EXPORT_AUDIT_CLIENT],
      useFactory: (db: PlatformDb, audit: AuditEventHandler) => new WorkspaceExportService(db, audit),
    },
    { provide: WORKSPACE_EXPORT_AUDIT_CLIENT, useFactory: engineAuditClientFromEnvironment },
    {
      provide: WorkspaceExportRunner,
      inject: [SystemNotificationStore, PlatformDb, EngineClient, AdsService, WORKSPACE_EXPORT_AUDIT_CLIENT],
      useFactory: (
        tenants: SystemNotificationStore,
        db: PlatformDb,
        engine: EngineClient,
        ads: AdsService,
        audit: AuditEventHandler,
      ) => new WorkspaceExportRunner(tenants, db, engine, ads, audit),
    },
  ],
})
export class WorkspaceExportModule {}
