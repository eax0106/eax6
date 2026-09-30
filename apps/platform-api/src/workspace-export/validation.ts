import { z } from "zod";
import { bareWorkspaceId } from "../workspaces/workspace-id";
import { WorkspaceExportHttpError } from "./problem";

const UUID_V7 = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

const exportIdPattern = new RegExp(`^exp_${UUID_V7}$`, "i");

/** A malformed workspace id names a workspace that does not exist. */
export function parseExportWorkspaceId(workspaceId: string, instance: string): string {
  const bare = bareWorkspaceId(workspaceId);
  if (!bare) {
    throw new WorkspaceExportHttpError(404, "WORKSPACE_NOT_FOUND", "Workspace not found", instance);
  }
  return bare;
}

export function parseExportId(exportId: string, instance: string): string {
  if (!exportIdPattern.test(exportId)) {
    throw new WorkspaceExportHttpError(404, "EXPORT_NOT_FOUND", "Export not found", instance);
  }
  return exportId;
}

const exportBodySchema = z.object({}).strict();

export function parseExportBody(body: unknown, instance: string): void {
  const parsed = exportBodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new WorkspaceExportHttpError(400, "INVALID_EXPORT_REQUEST", "Export request takes no body", instance);
  }
}
