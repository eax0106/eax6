import { resolve } from "node:path";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { MemoryServiceClient, MemoryServiceClientError } from "@alterx/adapters";
import { TenantIdSchema, UserIdSchema, WorkspaceIdSchema, WorkspaceMemorySettingsSchema,
  WorkspaceMemoryValuesSchema, type WorkspaceMemorySettings } from "@alterx/contracts";
import type { ActorContextType } from "../rbac";
import { PlatformHttpError } from "../signup/problem";

const BASE = "/api/v1/memory-settings";

@Injectable()
export class MemorySettingsService implements OnModuleDestroy {
  constructor(private client?: MemoryServiceClient) {}

  onModuleDestroy(): void { this.client?.close(); }

  async get(actor: ActorContextType | undefined): Promise<WorkspaceMemorySettings> {
    const scope = this.scope(actor);
    return this.request(client => client.getMemorySettings(scope));
  }

  async set(actor: ActorContextType | undefined, body: unknown, ifMatch: string | undefined): Promise<WorkspaceMemorySettings> {
    const scope = this.scope(actor, true);
    const parsed = WorkspaceMemoryValuesSchema.safeParse(body);
    if (!parsed.success) throw new PlatformHttpError(400, "MEMORY_SETTINGS_INVALID", "Three boolean switches and integer retentionDays from 7 to 365 are required", BASE);
    if (!ifMatch?.trim()) throw new PlatformHttpError(428, "IF_MATCH_REQUIRED", "If-Match header required", BASE);
    const actorId = UserIdSchema.safeParse(actor!.user_id.startsWith("usr_") ? actor!.user_id : `usr_${actor!.user_id}`);
    if (!actorId.success) throw new PlatformHttpError(403, "MEMORY_ACTOR_REQUIRED", "Valid workspace user required", BASE);
    return this.request(client => client.updateMemorySettings({
      ...scope, actor_id: actorId.data, settings_json: JSON.stringify(parsed.data), if_match: ifMatch.trim(),
    }));
  }

  private scope(actor: ActorContextType | undefined, write = false) {
    if (!actor) throw new PlatformHttpError(401, "AUTHENTICATION_REQUIRED", "Authenticated actor required", BASE);
    const tenant = TenantIdSchema.safeParse(actor.tenant_id.startsWith("ten_") ? actor.tenant_id : `ten_${actor.tenant_id}`);
    const workspace = WorkspaceIdSchema.safeParse(actor.workspace_id?.startsWith("ws_") ? actor.workspace_id : `ws_${actor.workspace_id ?? ""}`);
    if (!tenant.success || !workspace.success) throw new PlatformHttpError(403, "MEMORY_WORKSPACE_REQUIRED", "Valid workspace context required", BASE);
    const binding = actor.workspaceRoles?.find(row => (row.workspaceId.startsWith("ws_") ? row.workspaceId : `ws_${row.workspaceId}`) === workspace.data);
    const roles = write ? ["admin"] : ["admin", "editor", "operator", "approver", "viewer"];
    if (!binding || !roles.includes(binding.role)) throw new PlatformHttpError(403, "MEMORY_ROLE_DENIED", "Workspace role required", BASE);
    return { tenant_id: tenant.data, workspace_id: workspace.data };
  }

  private memory(): MemoryServiceClient {
    if (this.client) return this.client;
    const address = process.env["MEMORY_SERVICE_ADDRESS"]?.trim();
    const authorization = process.env["MEMORY_SERVICE_AUTHORIZATION"]?.trim();
    if (!address || !authorization?.startsWith("Bearer ") || !authorization.slice(7).trim()) {
      throw new PlatformHttpError(503, "MEMORY_SETTINGS_UNAVAILABLE", "Memory settings unavailable", BASE);
    }
    this.client = new MemoryServiceClient({ address, authorization,
      protoPath: resolve(process.cwd(), "packages/contracts/proto/alter/memory/v1/memory.proto") });
    return this.client;
  }

  private async request(operation: (client: MemoryServiceClient) => Promise<{ readonly settings_json: string }>): Promise<WorkspaceMemorySettings> {
    try {
      const response = await operation(this.memory());
      return WorkspaceMemorySettingsSchema.parse(JSON.parse(response.settings_json));
    } catch (error: unknown) {
      if (error instanceof PlatformHttpError) throw error;
      if (error instanceof MemoryServiceClientError) {
        if (error.code === "precondition_required") throw new PlatformHttpError(428, "IF_MATCH_REQUIRED", "If-Match header required", BASE);
        if (error.code === "conflict") throw new PlatformHttpError(412, "ETAG_MISMATCH", "Resource changed since it was read", BASE);
        if (error.code === "invalid_argument") throw new PlatformHttpError(400, "MEMORY_SETTINGS_INVALID", "Memory settings rejected", BASE);
      }
      throw new PlatformHttpError(503, "MEMORY_SETTINGS_UNAVAILABLE", "Memory settings unavailable", BASE);
    }
  }
}
