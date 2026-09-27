import { randomUUID } from "node:crypto";
import { HttpException, Injectable } from "@nestjs/common";
import { AdminAuditService } from "../admin-audit";
import { AdminUsersRepository } from "./admin-users.repository";
import type { AdminUserActionView, AdminUserView } from "./types";

/**
 * Admin console, users (task B1.2). Suspending a user takes effect at once:
 * the session store only accepts sessions of active users, and suspension
 * also revokes every live session so nothing cached outlives it.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly repository: AdminUsersRepository,
    private readonly audit: AdminAuditService,
  ) {}

  list(): Promise<AdminUserView[]> {
    return this.repository.list();
  }

  get(id: string, instance: string): Promise<AdminUserView> {
    return this.require(id, instance);
  }

  async actions(id: string, instance: string): Promise<AdminUserActionView[]> {
    await this.require(id, instance);
    return this.repository.listActions(id);
  }

  async suspend(id: string, staffUserId: string, reason: string, instance: string): Promise<AdminUserView> {
    await this.require(id, instance);
    await this.repository.setStatus(id, "suspended");
    await this.repository.revokeSessions(id);
    await this.repository.recordAction(id, staffUserId, "suspended", reason);
    await this.recordAudit(staffUserId, "user.suspend", id);
    return this.require(id, instance);
  }

  async reinstate(id: string, staffUserId: string, instance: string): Promise<AdminUserView> {
    await this.require(id, instance);
    await this.repository.setStatus(id, "active");
    await this.repository.recordAction(id, staffUserId, "reinstated", null);
    await this.recordAudit(staffUserId, "user.reinstate", id);
    return this.require(id, instance);
  }

  async revokeSessions(id: string, staffUserId: string, reason: string, instance: string): Promise<{ revoked: number }> {
    await this.require(id, instance);
    const revoked = await this.repository.revokeSessions(id);
    await this.repository.recordAction(id, staffUserId, "sessions_revoked", reason);
    await this.recordAudit(staffUserId, "user.sessions_revoke", id);
    return { revoked };
  }

  private async require(id: string, instance: string): Promise<AdminUserView> {
    const user = await this.repository.find(id);
    if (!user) {
      throw new HttpException(
        {
          type: "https://errors.alter.ai/user-not-found",
          title: "USER_NOT_FOUND",
          status: 404,
          detail: "User not found",
          instance,
          error_code: "USER_NOT_FOUND",
          trace_id: `trc_${randomUUID()}`,
          request_id: `req_${randomUUID()}`,
          retryable: false,
          field_errors: [],
          documentation_key: "user.not.found",
        },
        404,
      );
    }
    return user;
  }

  private async recordAudit(staffUserId: string, action: string, userId: string): Promise<void> {
    await this.audit.record({
      actorType: "admin",
      actorRef: staffUserId,
      action,
      targetType: "user",
      targetRef: userId,
      scope: "user:write",
    });
  }
}
