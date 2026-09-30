import { TenantIdSchema, WorkspaceIdSchema } from "@alterx/contracts";
import { z } from "zod";
import type { OrchestrationTenantStore } from "../runs/run-observability.service";

const inputSchema = z.object({
  workspace_id: WorkspaceIdSchema,
  collection: z.enum(["workflows", "workflow_versions", "runs"]),
  limit: z.coerce.number().int().min(1).max(200).default(200),
  cursor: z.string().min(1).max(2048).optional(),
}).strict();
const cursorSchema = z.object({
  workspace_id: WorkspaceIdSchema,
  collection: inputSchema.shape.collection,
  id: z.string().min(1).max(300),
}).strict();

export class EngineWorkspaceExportValidationError extends Error {}

/** Read projections for the asynchronous workspace archive, with no payloads or credentials. */
export class EngineWorkspaceExportService {
  constructor(private readonly store: OrchestrationTenantStore) {}

  async page(tenantInput: string, input: unknown) {
    const tenant = TenantIdSchema.safeParse(tenantInput.startsWith("ten_") ? tenantInput : `ten_${tenantInput}`);
    const parsed = inputSchema.safeParse(input);
    if (!tenant.success || !parsed.success) throw new EngineWorkspaceExportValidationError("Invalid workspace export query");
    const { workspace_id: workspaceId, collection, limit, cursor } = parsed.data;
    const tenantId = tenant.data.slice(4);
    let after: string | null = null;
    if (cursor !== undefined) {
      try {
        const decoded = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
        if (decoded.workspace_id !== workspaceId || decoded.collection !== collection) throw new Error("Cursor context differs");
        after = decoded.id;
      } catch {
        throw new EngineWorkspaceExportValidationError("Invalid workspace export cursor");
      }
    }

    return this.store.withTenant(tenantId, async (tx) => {
      // Fixed projections only. Run inputs, outputs, secrets and internal cost fields are not archive metadata.
      const source = collection === "workflow_versions"
        ? "workflow_versions x JOIN workflows w ON w.tenant_id = x.tenant_id AND w.id = x.workflow_id"
        : `${collection} x`;
      const workspaceColumn = collection === "workflow_versions" ? "w.workspace_id" : "x.workspace_id";
      const fields = collection === "workflows"
        ? "x.id, x.name, x.status, x.created_at::text, x.updated_at::text"
        : collection === "workflow_versions"
          ? "x.id, x.workflow_id, x.version, x.status, x.dag_schema_version, x.created_at::text"
          : "x.id, x.workflow_id, x.conversation_id, x.trigger_id, x.status, x.started_at::text, x.ended_at::text, x.created_at::text";
      const values = [tenantId, workspaceId.slice(3)];
      if (after !== null) {
        const anchor = await tx.query(`SELECT x.id FROM ${source} WHERE x.tenant_id = $1 AND ${workspaceColumn} = $2 AND x.id = $3`, [...values, after]);
        if (anchor.rows.length !== 1) throw new EngineWorkspaceExportValidationError("Invalid workspace export cursor");
      }
      const result = await tx.query<{ id: string } & Record<string, unknown>>(
        `SELECT ${fields} FROM ${source}
          WHERE x.tenant_id = $1 AND ${workspaceColumn} = $2 AND ($3::text IS NULL OR x.id > $3)
          ORDER BY x.id LIMIT $4`,
        [...values, after, limit + 1],
      );
      const hasMore = result.rows.length > limit;
      const data = result.rows.slice(0, limit).map((row) => ({ ...row, workspace_id: workspaceId }));
      const last = data.at(-1);
      return {
        data,
        page: {
          has_more: hasMore,
          next_cursor: hasMore && last ? Buffer.from(JSON.stringify({ workspace_id: workspaceId, collection, id: last.id })).toString("base64url") : null,
          limit,
        },
      };
    });
  }
}
