import { CompiledDagSchema } from "@alterx/contracts";
import { z } from "zod";
import { WorkflowHttpError } from "./problem";

const workflowIdPattern =
  /^wf_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const traceparentPattern =
  /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i;
const workflowVersionIdPattern =
  /^wfv_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const createWorkflowSchema = z
  .object({
    goal: z.string().trim().min(1).max(10_000),
  })
  .strict();

export const saveCanvasSchema = z
  .object({
    dag: CompiledDagSchema,
  })
  .strict();

export const approvalPolicySchema = z.object({
  mode: z.enum(["ask", "auto"]),
  skip_on_timeout: z.boolean().default(false),
  timeout_seconds: z.number().int().min(60).max(2_592_000).nullable().default(null),
  confirm_consequence: z.string().max(500).optional(),
}).strict().refine((input) => !input.skip_on_timeout || input.timeout_seconds !== null, {
  message: "skip_on_timeout needs timeout_seconds", path: ["timeout_seconds"],
});
export type ApprovalPolicyInput = z.infer<typeof approvalPolicySchema>;

export const emptyActionSchema = z.object({}).strict();

export const simulateWorkflowSchema = z
  .object({
    input: z.record(z.string(), z.json()),
  })
  .strict();

export const workflowVersionActionSchema = z
  .object({ workflowVersionId: z.string().regex(workflowVersionIdPattern) })
  .strict();

export const startCanarySchema = workflowVersionActionSchema.extend({
  trafficPercent: z.number().int().min(1).max(99),
}).strict();

const templateVariableDefinitionSchema = z.object({
  name: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  value_type: z.enum(["text", "number", "secret", "list"]),
  required: z.boolean(),
}).strict();

export const replaceTemplateVariablesSchema = z.object({
  definitions: z.array(templateVariableDefinitionSchema),
}).strict();

export const setTemplateVariableValueSchema = z.object({ value: z.json() }).strict();

export function parseWorkflowInput<T>(
  schema: z.ZodType<T>,
  input: unknown,
  instance: string,
): T {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  throw new WorkflowHttpError(
    400,
    "INVALID_WORKFLOW_REQUEST",
    "Workflow request validation failed",
    instance,
    result.error.issues.map((issue) => ({
      field: issue.path.join(".") || "body",
      message: issue.message,
    })),
  );
}

export function parseWorkflowId(value: string, instance: string): string {
  if (!workflowIdPattern.test(value)) {
    throw new WorkflowHttpError(
      400,
      "INVALID_WORKFLOW_ID",
      "Workflow ID is invalid",
      instance,
      [{ field: "workflowId", message: "Expected wf_ UUIDv7 identifier" }],
    );
  }
  return value;
}

export function parseTraceparent(
  value: string | undefined,
  instance: string,
): string | undefined {
  if (value !== undefined && !traceparentPattern.test(value)) {
    throw new WorkflowHttpError(
      400,
      "INVALID_TRACE_CONTEXT",
      "traceparent header is invalid",
      instance,
      [{ field: "traceparent", message: "Expected W3C traceparent" }],
    );
  }
  return value;
}

export function parseVersionQuery(
  cursor: string | undefined,
  limit: string | undefined,
  instance: string,
): string {
  if (cursor !== undefined && (cursor.length < 1 || cursor.length > 512)) {
    throw invalidVersionQuery(instance, "cursor", "Expected 1-512 characters");
  }
  const parsedLimit = limit === undefined ? undefined : Number(limit);
  if (
    parsedLimit !== undefined &&
    (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200)
  ) {
    throw invalidVersionQuery(instance, "limit", "Expected integer from 1 to 200");
  }
  const query = new URLSearchParams();
  if (cursor !== undefined) query.set("cursor", cursor);
  if (parsedLimit !== undefined) query.set("limit", String(parsedLimit));
  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

/** Adds the engine's name search (task B3.4) to a list query string. */
export function withNameQuery(query: string, nameQuery: string | undefined, instance: string): string {
  if (nameQuery === undefined) return query;
  const q = nameQuery.trim();
  if (!q || q.length > 200) throw invalidVersionQuery(instance, "q", "Expected 1-200 characters");
  return `${query}${query ? "&" : "?"}q=${encodeURIComponent(q)}`;
}

function invalidVersionQuery(
  instance: string,
  field: string,
  message: string,
): WorkflowHttpError {
  return new WorkflowHttpError(
    400,
    "INVALID_WORKFLOW_REQUEST",
    "Workflow version query validation failed",
    instance,
    [{ field, message }],
  );
}
