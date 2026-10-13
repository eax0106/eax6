import { z } from "./zod";
import {
  IsoTimestampSchema,
  NonEmptyStringSchema,
  ProjectIdSchema,
  RunIdSchema,
  WorkflowIdSchema,
  WorkflowVersionIdSchema,
} from "./ids";

/**
 * The durable `runs` row's own lifecycle -- distinct from sse.ts's richer
 * `RunStatusSchema` (which also carries future Recovery-phase states like
 * `escalated`/`degraded` for the SSE wire). This is the smaller state
 * machine actually enforced by the `runs_status_check` DB constraint.
 */
export const RunLifecycleStatusSchema = z.enum([
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

export const RunParentKindSchema = z.enum(["workflow", "project"]);

export const RunRecordSchema = z
  .object({
    id: RunIdSchema,
    workflow_id: WorkflowIdSchema.nullable(),
    project_id: ProjectIdSchema.nullable(),
    workflow_version_id: WorkflowVersionIdSchema.nullable(),
    parent_kind: RunParentKindSchema,
    status: RunLifecycleStatusSchema,
    started_at: IsoTimestampSchema.nullable(),
    ended_at: IsoTimestampSchema.nullable(),
    created_at: IsoTimestampSchema,
  })
  .strict();

export const CreateRunRequestSchema = z
  .object({
    workflow_id: WorkflowIdSchema,
    // Omitted -> resolves to the workflow's currently promoted version.
    workflow_version_id: WorkflowVersionIdSchema.optional(),
    // Input for the workflow's root nodes, as a hosted form submission would supply it.
    input: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const RunListResponseSchema = z
  .object({
    data: z.array(RunRecordSchema),
    page: z
      .object({
        next_cursor: RunIdSchema.nullable(),
        has_more: z.boolean(),
        limit: z.number().int().min(1).max(200),
      })
      .strict(),
  })
  .strict();

export const RetryNodeRequestSchema = z
  .object({
    node_key: NonEmptyStringSchema,
  })
  .strict();

export type RunLifecycleStatus = z.infer<typeof RunLifecycleStatusSchema>;
export type RunRecord = z.infer<typeof RunRecordSchema>;
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;
export type RunListResponse = z.infer<typeof RunListResponseSchema>;
export type RetryNodeRequest = z.infer<typeof RetryNodeRequestSchema>;
