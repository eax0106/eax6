import { z } from "./zod";
import { WorkflowIdSchema } from "./ids";

export const WorkflowHealthStatusSchema = z.enum(["healthy", "warning", "critical", "not_enough_data"]);
export const WorkflowHealthDimensionSchema = z.object({
  score: z.number().min(0).max(100).nullable(),
  status: WorkflowHealthStatusSchema,
  summary: z.string().min(1),
  observations: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
}).strict();
export const WorkflowHealthResourceSchema = z.object({
  workflowId: WorkflowIdSchema,
  overallScore: z.number().min(0).max(100).nullable(),
  status: WorkflowHealthStatusSchema,
  dimensions: z.object({ validation: WorkflowHealthDimensionSchema, availability: WorkflowHealthDimensionSchema,
    correctness: WorkflowHealthDimensionSchema, reliability: WorkflowHealthDimensionSchema }).strict(),
  recentFailures: z.number().int().nonnegative(),
  degradedRuns: z.number().int().nonnegative(),
  lastEvaluatedAt: z.string().datetime(),
  window: z.object({ startAt: z.string().datetime(), endAt: z.string().datetime(), maximumRuns: z.literal(20), sampledRuns: z.number().int().min(0).max(20) }).strict(),
}).strict();
export const WorkflowHealthPageSchema = z.object({
  data: z.array(WorkflowHealthResourceSchema),
  page: z.object({ next_cursor: z.string().nullable(), has_more: z.boolean(), limit: z.number().int().min(1).max(200) }).strict(),
}).strict();
export type WorkflowHealthResource = z.infer<typeof WorkflowHealthResourceSchema>;
export type WorkflowHealthDimension = z.infer<typeof WorkflowHealthDimensionSchema>;
export type WorkflowHealthPage = z.infer<typeof WorkflowHealthPageSchema>;
