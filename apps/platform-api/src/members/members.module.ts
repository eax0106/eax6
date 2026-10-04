import { Module } from "@nestjs/common";
import type { AuditEventHandler } from "@alterx/shared-clients";
import { engineAuditClientFromEnvironment } from "../audit/engine-audit-client";
import { IDENTITY_PROVIDER, IdentityModule } from "../identity/identity.module";
import type { IdentityProvider } from "../identity/identity-provider.interface";
import { PlatformDb } from "../signup/platform-db";
import { SignupModule } from "../signup/signup.module";
import { MembersController } from "./members.controller";
import { MembersService } from "./members.service";
import { WorkspaceInvitationsService } from "./workspace-invitations.service";

const MEMBERS_AUDIT_CLIENT = Symbol("MEMBERS_AUDIT_CLIENT");
@Module({
  imports: [SignupModule, IdentityModule],
  controllers: [MembersController],
  providers: [
    { provide: MEMBERS_AUDIT_CLIENT, useFactory: engineAuditClientFromEnvironment },
    { provide: WorkspaceInvitationsService, inject: [PlatformDb, IDENTITY_PROVIDER, MEMBERS_AUDIT_CLIENT],
      useFactory: (db: PlatformDb, provider: IdentityProvider, audit: AuditEventHandler) => new WorkspaceInvitationsService(db, provider, audit) },
    { provide: MembersService, inject: [PlatformDb, MEMBERS_AUDIT_CLIENT, WorkspaceInvitationsService],
      useFactory: (db: PlatformDb, audit: AuditEventHandler, invitations: WorkspaceInvitationsService) => new MembersService(db, undefined, audit, invitations) },
  ],
})
export class MembersModule {}
