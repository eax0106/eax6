import { Module } from "@nestjs/common";
import type { AuditEventHandler } from "@alterx/shared-clients";
import { engineAuditClientFromEnvironment } from "../audit/engine-audit-client";
import { validatePlatformApiEnv } from "../config/env.schema";
import { AuditEventsClient, EngineClient, EngineModule } from "../engine";
import { NotificationModule } from "../notifications/notification.module";
import { SystemNotificationStore } from "../notifications/system-notification-store";
import { PlatformDb } from "../signup/platform-db";
import { SignupModule } from "../signup/signup.module";
import { WorkspaceDeletionService } from "./workspace-deletion.service";
import { WorkspaceErasureTriggerController } from "./workspace-erasure-trigger.controller";
import { WorkspaceErasureRunner } from "./workspace-erasure.runner";
import { WorkspaceSafeguardsService } from "./workspace-safeguards.service";
import { WorkspacesController } from "./workspaces.controller";
import { WorkspacesService } from "./workspaces.service";

const WORKSPACE_AUDIT_CLIENT = Symbol("WORKSPACE_AUDIT_CLIENT");

@Module({
  imports: [SignupModule, EngineModule, NotificationModule],
  controllers: [WorkspacesController, WorkspaceErasureTriggerController],
  providers: [
    {
      provide: WorkspacesService,
      inject: [PlatformDb],
      useFactory: (db: PlatformDb) => new WorkspacesService(db),
    },
    { provide: WORKSPACE_AUDIT_CLIENT, useFactory: engineAuditClientFromEnvironment },
    {
      provide: WorkspaceSafeguardsService,
      inject: [PlatformDb, WORKSPACE_AUDIT_CLIENT],
      useFactory: (db: PlatformDb, audit: AuditEventHandler) =>
        new WorkspaceSafeguardsService(db, audit),
    },
    {
      provide: WorkspaceDeletionService,
      inject: [PlatformDb, EngineClient, WORKSPACE_AUDIT_CLIENT],
      useFactory: (db: PlatformDb, engine: EngineClient, audit: AuditEventHandler) =>
        new WorkspaceDeletionService(
          db,
          engine,
          audit,
          validatePlatformApiEnv(process.env).WORKSPACE_DELETION_WINDOW_DAYS,
        ),
    },
    {
      provide: WorkspaceErasureRunner,
      inject: [SystemNotificationStore, PlatformDb, AuditEventsClient, WORKSPACE_AUDIT_CLIENT],
      useFactory: (
        tenants: SystemNotificationStore,
        db: PlatformDb,
        erasure: AuditEventsClient,
        audit: AuditEventHandler,
      ) => new WorkspaceErasureRunner(tenants, db, erasure, audit),
    },
  ],
})
export class WorkspacesModule {}
