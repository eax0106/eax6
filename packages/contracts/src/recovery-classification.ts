import { z } from "./zod";
import {
  NonEmptyStringSchema,
  RequestIdSchema,
  TraceIdSchema,
} from "./ids";

/**
 * Locked HEAL-5 -> HEAL-6 handoff. HEAL-6 must consume these values as-is
 * when applying its deterministic strategy table.
 */
export const FailureClassSchema = z.enum([
  "infrastructure_failure",
  "logic_output_failure",
  "timeout",
  "tool_permission_denial",
  "sandbox_crash",
  "rate_limit",
  "safety_violation",
  "credential_missing",
  "agent_creation_failure",
  "target_missing",
  "ambiguous_outcome",
  "unknown",
]);

export const SafetySeveritySchema = z.enum([
  "low",
  "medium",
  "high",
  "critical",
]);

export const FailureObservationSchema = z
  .object({
    trace_id: TraceIdSchema,
    request_id: RequestIdSchema,
    error_code: z.string().trim().min(1).max(128).optional(),
    detail: z.string().trim().min(1).max(2_048).optional(),
    retryable: z.boolean().optional(),
    verification: z
      .object({
        kind: z.enum(["build", "render"]),
        status: z.enum([
          "passed",
          "logic_failure",
          "infra_failure",
          "inconclusive",
        ]),
        error_code: z.string().trim().min(1).max(128).optional(),
        detail: z.string().trim().min(1).max(2_048).optional(),
      })
      .strict()
      .optional(),
    /** Optional HEAL-3 additive signal. HEAL-5 never derives this itself. */
    safety_severity: SafetySeveritySchema.optional(),
  })
  .strict();

export const RootCauseEstimateSchema = z
  .object({
    schema_version: z.literal("heal5.v1"),
    failure_class: FailureClassSchema,
    explanation: NonEmptyStringSchema.max(2_048),
    confidence: z.number().min(0).max(1),
    evidence: z.array(NonEmptyStringSchema.max(512)).min(1).max(8),
    node_attempt: z.number().int().min(1),
    model_alias: z.literal("ADVANCED"),
    resolved_capability: NonEmptyStringSchema.max(256),
  })
  .strict();

export type FailureClass = z.infer<typeof FailureClassSchema>;
export type FailureObservation = z.infer<typeof FailureObservationSchema>;
export type RootCauseEstimate = z.infer<typeof RootCauseEstimateSchema>;
