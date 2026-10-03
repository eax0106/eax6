import {
  TenantIdSchema, WorkspaceIdSchema, WorkflowFolderIdSchema, WorkflowFolderInputSchema,
  WorkflowFolderMoveSchema, WorkflowIdSchema, type WorkflowFolder, type WorkflowFolderPlacement,
} from "@alterx/contracts";
import type { OrchestrationTenantStore, OrchestrationTransactionLike } from "../project-read/project-read.service";
import { uuidV7 } from "../trigger-bindings/ids";

type FolderRow = Record<string, unknown> & { id: string; workspace_id: string; name: string; revision: number };
type PlacementRow = Record<string, unknown> & { id: string; folder_id: string | null; folder_revision: number };
export class WorkflowFolderError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const folderView = (row: FolderRow): WorkflowFolder => ({
  id: row.id, workspaceId: `ws_${row.workspace_id}`, name: row.name, etag: `"folder-${row.id}-${row.revision}"`,
});
const placementView = (row: PlacementRow): WorkflowFolderPlacement => ({
  workflowId: row.id, folderId: row.folder_id, etag: `"workflow-folder-${row.id}-${row.folder_revision}"`,
});
function match(ifMatch: string | undefined, current: string): void {
  if (!ifMatch) throw new WorkflowFolderError(428, "PRECONDITION_REQUIRED", "If-Match is required");
  if (ifMatch !== current) throw new WorkflowFolderError(412, "PRECONDITION_FAILED", "Resource changed; reload before editing");
}

export class WorkflowFoldersService {
  constructor(private readonly store: OrchestrationTenantStore) {}

  private scoped<T>(tenantId: string, workspaceId: string, operation: (tx: OrchestrationTransactionLike, tenant: string, workspace: string) => Promise<T>): Promise<T> {
    const tenant = TenantIdSchema.parse(tenantId).slice(4), workspace = WorkspaceIdSchema.parse(workspaceId).slice(3);
    return this.store.withTenant(tenant, tx => operation(tx, tenant, workspace));
  }

  async list(tenantId: string, workspaceId: string): Promise<readonly WorkflowFolder[]> {
    return this.scoped(tenantId, workspaceId, async (tx, tenant, workspace) => {
      // ponytail: one workspace collection; add pagination when folder counts justify it.
      const rows = await tx.query<FolderRow>("SELECT id, workspace_id, name, revision FROM workflow_folders WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY name, id", [tenant, workspace]);
      return rows.rows.map(folderView);
    });
  }

  async create(tenantId: string, workspaceId: string, body: unknown): Promise<WorkflowFolder> {
    const { name } = WorkflowFolderInputSchema.parse(body);
    return this.scoped(tenantId, workspaceId, async (tx, tenant, workspace) => {
      const result = await tx.query<FolderRow>("INSERT INTO workflow_folders(id,tenant_id,workspace_id,name) VALUES($1,$2,$3,$4) RETURNING id,workspace_id,name,revision", [`fld_${uuidV7()}`, tenant, workspace, name]);
      return folderView(result.rows[0]!);
    });
  }

  async rename(tenantId: string, workspaceId: string, folderId: string, body: unknown, ifMatch?: string): Promise<WorkflowFolder> {
    const id = WorkflowFolderIdSchema.parse(folderId), { name } = WorkflowFolderInputSchema.parse(body);
    return this.scoped(tenantId, workspaceId, async (tx, tenant, workspace) => {
      const row = await lockedFolder(tx, tenant, workspace, id);
      match(ifMatch, folderView(row).etag);
      const updated = await tx.query<FolderRow>("UPDATE workflow_folders SET name=$4,revision=revision+1 WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 RETURNING id,workspace_id,name,revision", [tenant, workspace, id, name]);
      return folderView(updated.rows[0]!);
    });
  }

  async remove(tenantId: string, workspaceId: string, folderId: string, ifMatch?: string): Promise<void> {
    const id = WorkflowFolderIdSchema.parse(folderId);
    return this.scoped(tenantId, workspaceId, async (tx, tenant, workspace) => {
      const row = await lockedFolder(tx, tenant, workspace, id);
      match(ifMatch, folderView(row).etag);
      await tx.query("UPDATE workflows SET folder_id=NULL,folder_revision=folder_revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND workspace_id=$2 AND folder_id=$3", [tenant, workspace, id]);
      await tx.query("DELETE FROM workflow_folders WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3", [tenant, workspace, id]);
    });
  }

  async placement(tenantId: string, workspaceId: string, workflowId: string): Promise<WorkflowFolderPlacement> {
    const id = WorkflowIdSchema.parse(workflowId);
    return this.scoped(tenantId, workspaceId, async (tx, tenant, workspace) => placementView(await workflowPlacement(tx, tenant, workspace, id, false)));
  }

  async move(tenantId: string, workspaceId: string, workflowId: string, body: unknown, ifMatch?: string): Promise<WorkflowFolderPlacement> {
    const id = WorkflowIdSchema.parse(workflowId), { folderId } = WorkflowFolderMoveSchema.parse(body);
    return this.scoped(tenantId, workspaceId, async (tx, tenant, workspace) => {
      // Folder before workflow, matching deletion's lock order. The key lock prevents deletion between validation and assignment.
      if (folderId !== null) await lockedFolder(tx, tenant, workspace, folderId, "FOR KEY SHARE");
      const row = await workflowPlacement(tx, tenant, workspace, id, true);
      match(ifMatch, placementView(row).etag);
      const updated = await tx.query<PlacementRow>("UPDATE workflows SET folder_id=$4,folder_revision=folder_revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 RETURNING id,folder_id,folder_revision", [tenant, workspace, id, folderId]);
      return placementView(updated.rows[0]!);
    });
  }
}

async function lockedFolder(tx: OrchestrationTransactionLike, tenant: string, workspace: string, id: string, lock = "FOR UPDATE"): Promise<FolderRow> {
  const row = (await tx.query<FolderRow>(`SELECT id,workspace_id,name,revision FROM workflow_folders WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 ${lock}`, [tenant, workspace, id])).rows[0];
  if (!row) throw new WorkflowFolderError(404, "FOLDER_NOT_FOUND", "Folder was not found");
  return row;
}
async function workflowPlacement(tx: OrchestrationTransactionLike, tenant: string, workspace: string, id: string, lock: boolean): Promise<PlacementRow> {
  const row = (await tx.query<PlacementRow>(`SELECT id,folder_id,folder_revision FROM workflows WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3${lock ? " FOR UPDATE" : ""}`, [tenant, workspace, id])).rows[0];
  if (!row) throw new WorkflowFolderError(404, "WORKFLOW_NOT_FOUND", "Workflow was not found");
  return row;
}
