import { z } from "zod";
import { CreateRunRequestSchema, type CreateRunRequest } from "@alterx/contracts";
import { RunHttpError } from "./problem";
import type { CancelRunRequest, RetryNodeRequest, RunListQuery } from "./types";

const uuidV7 =
  "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const idPatterns = {
  artifact: new RegExp(`^art_${uuidV7}$`, "i"),
  run: new RegExp(`^run_${uuidV7}$`, "i"),
};
const traceparentPattern =
  /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i;

const listQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    status: z
      .enum(["pending", "running", "paused", "completed", "failed", "cancelled"])
      .optional(),
    mode: z.enum(["workflow", "project"]).optional(),
    started_after: z.string().datetime({ offset: true }).optional(),
    started_before: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if (
      query.started_after &&
      query.started_before &&
      Date.parse(query.started_after) > Date.parse(query.started_before)
    ) {
      context.addIssue({
        code: "custom",
        path: ["started_before"],
        message: "started_before must not precede started_after",
      });
    }
  });

// The engine lists a workspace's artifacts newest first, paged by artifact id.
const artifactListQuerySchema = z
  .object({
    cursor: z.string().regex(idPatterns.artifact).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export function parseArtifactListQuery(
  input: unknown,
  instance: string,
): { cursor?: string | undefined; limit?: number | undefined } {
  return parse(artifactListQuerySchema, input, instance);
}

export function parseRunListQuery(
  input: unknown,
  instance: string,
): RunListQuery {
  return parse(listQuerySchema, input, instance);
}

export function parseCreateRunRequest(input: unknown, instance: string): CreateRunRequest {
  const result = CreateRunRequestSchema.safeParse(input);
  if (result.success) return result.data;
  throw validationError(
    instance,
    result.error.issues.map((issue) => ({
      field: issue.path.join(".") || "body",
      message: issue.message,
    })),
  );
}

// The engine's own retry-node route requires a non-empty node_key and
// rejects anything else (runs.controller.ts), so the same bodies are
// refused here rather than spending an engine round trip on them.
const retryNodeSchema = z
  .object({
    node_key: z.string().trim().min(1).max(512),
  })
  .strict();

export function parseRetryNodeRequest(
  input: unknown,
  instance: string,
): RetryNodeRequest {
  return parse(retryNodeSchema, input, instance);
}

const cancelSchema = z.object({}).strict();

export function parseCancelRunRequest(
  input: unknown,
  instance: string,
): CancelRunRequest {
  return parse(cancelSchema, input ?? {}, instance);
}

export function parseRunId(value: string, instance: string): string {
  return parseId(value, idPatterns.run, "runId", "run_ UUIDv7", instance);
}

export function parseArtifactId(value: string, instance: string): string {
  return parseId(
    value,
    idPatterns.artifact,
    "artifactId",
    "art_ UUIDv7",
    instance,
  );
}

export function parseTraceparent(
  value: string | undefined,
  instance: string,
): string | undefined {
  if (value !== undefined && !traceparentPattern.test(value)) {
    throw validationError(instance, [
      { field: "traceparent", message: "Expected W3C traceparent" },
    ]);
  }
  return value;
}

export function serializeQuery(
  query: object,
): string {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) parameters.set(key, String(value));
  }
  const serialized = parameters.toString();
  return serialized ? `?${serialized}` : "";
}

function parse<T>(schema: z.ZodType<T>, input: unknown, instance: string): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw validationError(
    instance,
    result.error.issues.map((issue) => ({
      field: issue.path.join(".") || "query",
      message: issue.message,
    })),
  );
}

function parseId(
  value: string,
  pattern: RegExp,
  field: string,
  expected: string,
  instance: string,
): string {
  if (!pattern.test(value)) {
    throw validationError(instance, [{ field, message: `Expected ${expected}` }]);
  }
  return value;
}

function validationError(
  instance: string,
  fieldErrors: NonNullable<
    ConstructorParameters<typeof RunHttpError>[4]
  >,
): RunHttpError {
  return new RunHttpError(
    400,
    "INVALID_RUN_REQUEST",
    "Run request validation failed",
    instance,
    fieldErrors,
  );
}
