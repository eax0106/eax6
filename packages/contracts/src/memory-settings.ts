import { z } from "./zod";
import { MemoryIdSchema } from "./ids";

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
export const WorkspaceWorkflowMemoriesSchema = z.array(z.object({
  id: MemoryIdSchema, content: z.record(z.string(), z.unknown()),
}).strict()).max(20).refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= 16_000,
  "Workflow memory exceeds recall limit");
