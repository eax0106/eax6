import { z } from "./zod";
import { WorkspaceIdSchema, WorkflowIdSchema, prefixedUuidV7 } from "./ids";

export const WorkflowFolderIdSchema = prefixedUuidV7("fld");
export const WorkflowFolderNameSchema = z.string().trim().min(1).max(160);
export const WorkflowFolderInputSchema = z.object({ name: WorkflowFolderNameSchema }).strict();
export const WorkflowFolderSchema = z.object({
  id: WorkflowFolderIdSchema,
  workspaceId: WorkspaceIdSchema,
  name: WorkflowFolderNameSchema,
  etag: z.string().regex(/^"folder-fld_[0-9a-f-]+-\d+"$/i),
}).strict();
export const WorkflowFolderListSchema = z.object({
  data: z.array(WorkflowFolderSchema),
  canEdit: z.boolean(),
}).strict();
export const WorkflowFolderMoveSchema = z.object({ folderId: WorkflowFolderIdSchema.nullable() }).strict();
export const WorkflowFolderPlacementSchema = z.object({
  workflowId: WorkflowIdSchema,
  folderId: WorkflowFolderIdSchema.nullable(),
  etag: z.string().regex(/^"workflow-folder-wf_[0-9a-f-]+-\d+"$/i),
}).strict();
export type WorkflowFolder = z.infer<typeof WorkflowFolderSchema>;
export type WorkflowFolderList = z.infer<typeof WorkflowFolderListSchema>;
export type WorkflowFolderPlacement = z.infer<typeof WorkflowFolderPlacementSchema>;
