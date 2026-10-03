import { z } from "./zod";

export const WorkspaceMemoryValuesSchema = z.object({
  conversationMemoryEnabled: z.boolean(),
  workflowMemoryEnabled: z.boolean(),
  workspaceMemoryEnabled: z.boolean(),
  retentionDays: z.number().int().min(7).max(365),
}).strict();
export const WorkspaceMemorySettingsSchema = WorkspaceMemoryValuesSchema.extend({
  etag: z.string().regex(/^"memory-\d+"$/),
}).strict();
export type WorkspaceMemoryValues = z.infer<typeof WorkspaceMemoryValuesSchema>;
export type WorkspaceMemorySettings = z.infer<typeof WorkspaceMemorySettingsSchema>;
