import { z } from "zod";
import type {
  ClarificationAnswerInput,
  CreateProjectInput,
  EmptyProjectActionInput,
  RejectPlanInput,
  RequestPlanChangesInput,
} from "./types";
import { ProjectHttpError } from "./problem";

const prefixedIdPattern =
  /^[a-z]+_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const traceparentPattern =
  /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i;

export const createProjectSchema: z.ZodType<CreateProjectInput> = z
  .object({
    brief: z.string().trim().min(1).max(20_000),
  })
  .strict();

export const clarificationAnswerSchema: z.ZodType<ClarificationAnswerInput> = z
  .object({
    answer: z
      .string()
      .min(1)
      .max(10_000)
      .refine((value) => value.trim().length > 0, "answer cannot be blank"),
  })
  .strict();

export const approvePlanSchema: z.ZodType<EmptyProjectActionInput> = z
  .object({})
  .strict();

export const rejectPlanSchema: z.ZodType<RejectPlanInput> = z
  .object({
    reason: z.string().trim().min(1).max(5_000),
  })
  .strict();

export const requestPlanChangesSchema: z.ZodType<RequestPlanChangesInput> = z
  .object({
    changes: z.string().trim().min(1).max(10_000),
  })
  .strict();

export const startBuildSchema: z.ZodType<EmptyProjectActionInput> = z
  .object({})
  .strict();

export function parseProjectInput<T>(
  schema: z.ZodType<T>,
  value: unknown,
  instance: string,
): T {
  const parsed = schema.safeParse(value ?? {});
  if (parsed.success) {
    return parsed.data;
  }
  throw new ProjectHttpError(
    400,
    "PROJECT_VALIDATION_FAILED",
    "Project request validation failed",
    instance,
    parsed.error.issues.map((issue) => ({
      field: issue.path.join(".") || "body",
      message: issue.message,
    })),
  );
}

export function parseProjectId(value: string, instance: string): string {
  if (!prefixedIdPattern.test(value) || !value.startsWith("prj_")) {
    throw invalidPath(instance, "projectId");
  }
  return value;
}

export function parseProjectListQuery(
  cursor: string | undefined,
  limit: string | undefined,
  instance: string,
  nameQuery?: string,
): string {
  if (
    cursor !== undefined &&
    (!prefixedIdPattern.test(cursor) || !cursor.startsWith("prj_"))
  ) {
    throw invalidListQuery(instance, "cursor", "Expected a project ID");
  }
  const parsedLimit = limit === undefined ? undefined : Number(limit);
  if (
    parsedLimit !== undefined &&
    (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200)
  ) {
    throw invalidListQuery(instance, "limit", "Expected integer from 1 to 200");
  }
  const q = nameQuery?.trim();
  if (nameQuery !== undefined && (!q || q.length > 200)) {
    throw invalidListQuery(instance, "q", "Expected 1-200 characters");
  }
  const query = new URLSearchParams();
  if (cursor !== undefined) query.set("cursor", cursor);
  if (parsedLimit !== undefined) query.set("limit", String(parsedLimit));
  if (q) query.set("q", q);
  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

function invalidListQuery(
  instance: string,
  field: string,
  message: string,
): ProjectHttpError {
  return new ProjectHttpError(
    400,
    "PROJECT_VALIDATION_FAILED",
    "Project request validation failed",
    instance,
    [{ field, message }],
  );
}

export function parseClarificationId(
  value: string,
  instance: string,
): string {
  if (!prefixedIdPattern.test(value) || !value.startsWith("clr_")) {
    throw invalidPath(instance, "clarificationId");
  }
  return value;
}

export function parseTraceparent(
  value: string | undefined,
  instance: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!traceparentPattern.test(value)) {
    throw new ProjectHttpError(
      400,
      "PROJECT_VALIDATION_FAILED",
      "Project request validation failed",
      instance,
      [{ field: "traceparent", message: "Invalid traceparent header" }],
    );
  }
  return value;
}

function invalidPath(instance: string, field: string): ProjectHttpError {
  return new ProjectHttpError(
    400,
    "PROJECT_VALIDATION_FAILED",
    "Project request validation failed",
    instance,
    [{ field, message: `Invalid ${field}` }],
  );
}
