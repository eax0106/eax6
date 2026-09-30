import { z } from "zod";
import { WorkflowIdSchema } from "@alterx/contracts";
import { BudgetHttpError } from "./problem";
import type { CreateBudgetInput, UpdateBudgetInput } from "./types";

// Up to 10 crore rupees, in paise.
const amountMinor = z.number().int().positive().max(10_000_000_000);
const workflowId = WorkflowIdSchema;
const mode = z.enum(["hard", "warn"]);

// D3: a per-run cap and a workflow budget belong to a workflow; the workspace
// budget is monthly. The engine checks the same shape again.
const createSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace"), amount_minor: amountMinor, mode: mode.default("hard") }).strict(),
  z
    .object({ kind: z.literal("workflow"), workflow_id: workflowId, period: z.enum(["daily", "monthly"]), amount_minor: amountMinor, mode: mode.default("hard") })
    .strict(),
  z.object({ kind: z.literal("run_cap"), workflow_id: workflowId, amount_minor: amountMinor, mode: mode.default("hard") }).strict(),
]);

const updateSchema = z
  .object({ amount_minor: amountMinor, mode, enabled: z.boolean() })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export function parseCreateBudget(input: unknown, instance: string): CreateBudgetInput {
  return parse(createSchema, input, instance);
}

export function parseUpdateBudget(input: unknown, instance: string): UpdateBudgetInput {
  return parse(updateSchema, input, instance);
}

export function parseBudgetId(value: string, instance: string): string {
  if (!/^bud_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new BudgetHttpError(400, "VALIDATION_ERROR", "Invalid budget id", instance, [{ field: "budgetId", message: "Invalid budget id" }]);
  }
  return value;
}

function parse<T>(schema: z.ZodType<T>, input: unknown, instance: string): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new BudgetHttpError(
    400,
    "VALIDATION_ERROR",
    "Request validation failed",
    instance,
    result.error.issues.map((issue) => ({ field: issue.path.map(String).join(".") || "body", message: issue.message })),
  );
}
