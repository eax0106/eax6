import { z } from "zod";
import { BudgetHttpError } from "./problem";
import type { CreateBudgetInput, UpdateBudgetInput } from "./types";

const thresholds = z
  .array(z.object({ percent: z.number().int().min(1).max(100), action: z.enum(["notify", "warn", "block"]) }).strict())
  .max(10)
  .refine((items) => new Set(items.map((item) => `${item.percent}:${item.action}`)).size === items.length, "Thresholds must be distinct");
const name = z.string().trim().min(1).max(120);
// Up to 10 crore rupees or 10 million dollars, in minor units.
const amountMinor = z.number().int().positive().max(10_000_000_000);

const createSchema = z
  .object({
    name,
    amount_minor: amountMinor,
    currency: z.enum(["INR", "USD"]),
    period: z.literal("monthly").default("monthly"),
    thresholds: thresholds.default([]),
    enabled: z.boolean().default(true),
  })
  .strict();

const updateSchema = z
  .object({ name, amount_minor: amountMinor, thresholds, enabled: z.boolean() })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export function parseCreateBudget(input: unknown, instance: string): CreateBudgetInput {
  const value = parse(createSchema, input, instance);
  return {
    name: value.name,
    amountMinor: value.amount_minor,
    currency: value.currency,
    period: value.period,
    thresholds: value.thresholds,
    enabled: value.enabled,
  };
}

export function parseUpdateBudget(input: unknown, instance: string): UpdateBudgetInput {
  const value = parse(updateSchema, input, instance);
  return {
    ...(value.name !== undefined ? { name: value.name } : {}),
    ...(value.amount_minor !== undefined ? { amountMinor: value.amount_minor } : {}),
    ...(value.thresholds !== undefined ? { thresholds: value.thresholds } : {}),
    ...(value.enabled !== undefined ? { enabled: value.enabled } : {}),
  };
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
