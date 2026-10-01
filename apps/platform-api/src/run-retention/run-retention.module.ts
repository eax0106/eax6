import { Module } from "@nestjs/common";
import type { AuditEventHandler } from "@alterx/shared-clients";
import { engineAuditClientFromEnvironment } from "../audit/engine-audit-client";
import { EngineClient, EngineModule } from "../engine";
import { RunRetentionController } from "./run-retention.controller";
import { RunRetentionService } from "./run-retention.service";

const RUN_RETENTION_AUDIT_CLIENT = Symbol("RUN_RETENTION_AUDIT_CLIENT");

@Module({
  imports: [EngineModule],
  controllers: [RunRetentionController],
  providers: [
    { provide: RUN_RETENTION_AUDIT_CLIENT, useFactory: engineAuditClientFromEnvironment },
    {
      provide: RunRetentionService,
      inject: [EngineClient, RUN_RETENTION_AUDIT_CLIENT],
      useFactory: (engine: EngineClient, audit: AuditEventHandler) => new RunRetentionService(engine, audit),
    },
  ],
})
export class RunRetentionModule {}
