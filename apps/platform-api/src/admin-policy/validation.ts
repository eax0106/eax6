import { z } from "zod";
import { PlanCommercialSchema } from "../entitlements/plan-commercial";
import { ENTITLEMENT_LIMIT_KEYS } from "../entitlements/types";
import { AdminPolicyHttpError } from "./problem";
import type {
  DeletePlanDefinitionInput,
  UpsertPlanDefinitionInput,
} from "./types";

const planPattern = /^[a-z0-9][a-z0-9_-]{0,99}$/;

/**
 * Every limit key is required on write: a plan definition replaces the
 * ConfigProvider baseline outright rather than merging onto it, so a partial
 * body would silently leave the omitted limits at the baseline's value and
 * make the effective policy unreadable from the console.
 */
const limitsSchema = z
  .object(
    Object.fromEntries(
      ENTITLEMENT_LIMIT_KEYS.map((key) => [
        key,
        z.number().int().nonnegative(),
      ]),
    ),
  )
  .strict();

const upsertSchema = z
  .object({
    limits: limitsSchema,
    commercial: PlanCommercialSchema.nullable().optional(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

const deleteSchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export function parsePlanName(value: string, instance: string): string {
  if (!planPattern.test(value)) {
    throw validationError(instance, [
      { field: "plan", message: "Invalid plan identifier" },
    ]);
  }
  return value;
}

export function parseHistoryLimit(value: unknown, instance: string): number {
  if (value === undefined) return 50;
  const parsed = z.coerce.number().int().min(1).max(200).safeParse(value);
  if (!parsed.success) {
    throw validationError(instance, [
      { field: "limit", message: "limit must be an integer between 1 and 200" },
    ]);
  }
  return parsed.data;
}

export function parseUpsertPlanDefinitionInput(
  value: unknown,
  instance: string,
): UpsertPlanDefinitionInput {
  return parse(upsertSchema, value, instance);
}

export function parseDeletePlanDefinitionInput(
  value: unknown,
  instance: string,
): DeletePlanDefinitionInput {
  return parse(deleteSchema, value, instance);
}

function parse<T>(schema: z.ZodType, value: unknown, instance: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data as T;
  throw validationError(
    instance,
    parsed.error.issues.map((issue) => ({
      field: issue.path.join(".") || "body",
      message: issue.message,
    })),
  );
}

function validationError(
  instance: string,
  fieldErrors: Array<{ field: string; message: string }>,
): AdminPolicyHttpError {
  return new AdminPolicyHttpError(
    400,
    "ADMIN_POLICY_VALIDATION_FAILED",
    "Admin policy request validation failed",
    instance,
    fieldErrors,
  );
}
