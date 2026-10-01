import { Module } from "@nestjs/common";
import type { AuditEventHandler } from "@alterx/shared-clients";
import { engineAuditClientFromEnvironment } from "../audit/engine-audit-client";
import { EngineClient, EngineModule } from "../engine";
import { RunRetentionRelayController } from "./run-retention.controller";
import { RunRetentionRelayService } from "./run-retention.service";

const RUN_RETENTION_AUDIT_CLIENT = Symbol("RUN_RETENTION_AUDIT_CLIENT");

@Module({
  imports: [EngineModule],
  controllers: [RunRetentionRelayController],
  providers: [
    { provide: RUN_RETENTION_AUDIT_CLIENT, useFactory: engineAuditClientFromEnvironment },
    {
      provide: RunRetentionRelayService,
      inject: [EngineClient, RUN_RETENTION_AUDIT_CLIENT],
      useFactory: (engine: EngineClient, audit: AuditEventHandler) => new RunRetentionRelayService(engine, audit),
    },
  ],
})
export class RunRetentionModule {}
