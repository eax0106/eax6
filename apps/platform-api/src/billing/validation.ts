import { z } from "zod";
import { BillingHttpError } from "./problem";
import type {
  AttachPaymentMethodInput,
  ChangeSubscriptionInput,
  CreateSubscriptionInput,
} from "./types";

const providerRef = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value.trim().length > 0, "Expected provider reference")
  .refine(
    (value) => value === value.trim(),
    "Provider reference must not contain surrounding whitespace",
  );
const createSubscriptionSchema = z
  .object({
    plan_id: providerRef,
    plan_version: z.string().datetime(),
    gstin: z.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/).optional(),
  })
  .strict();
const changeSubscriptionSchema = z
  .object({ plan_id: providerRef, plan_version: z.string().datetime() })
  .strict();
const attachPaymentMethodSchema = z
  .object({ provider_token: providerRef })
  .strict();

export function parseCreateSubscription(
  input: unknown,
  instance: string,
): CreateSubscriptionInput {
  const parsed = parse(createSubscriptionSchema, input, instance);
  return { plan_id: parsed.plan_id, plan_version: parsed.plan_version,
    ...(parsed.gstin === undefined ? {} : { gstin: parsed.gstin }) };
}

export function parseChangeSubscription(
  input: unknown,
  instance: string,
): ChangeSubscriptionInput {
  return parse(changeSubscriptionSchema, input, instance);
}

export function parseAttachPaymentMethod(
  input: unknown,
  instance: string,
): AttachPaymentMethodInput {
  return parse(attachPaymentMethodSchema, input, instance);
}

export function parseInvoicesQuery(
  cursor: string | undefined,
  limit: string | undefined,
  instance: string,
): { cursor?: string; limit?: number } {
  const parsedLimit = limit === undefined ? undefined : Number(limit);
  if (
    parsedLimit !== undefined &&
    (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100)
  ) {
    throw invalid(instance, [
      { field: "limit", message: "Expected integer from 1 to 100" },
    ]);
  }
  if (
    cursor !== undefined &&
    (!/^\d+$/.test(cursor) || Number(cursor) < 0)
  ) {
    throw invalid(instance, [
      { field: "cursor", message: "Expected non-negative integer cursor" },
    ]);
  }
  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
  };
}

export function parsePaymentMethodRef(
  value: string,
  instance: string,
): string {
  const result = providerRef.safeParse(value);
  if (!result.success) {
    throw invalid(instance, [
      { field: "ref", message: "Expected provider token reference" },
    ]);
  }
  return result.data;
}

function parse<T>(schema: z.ZodType<T>, input: unknown, instance: string): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw invalid(
    instance,
    result.error.issues.map((issue) => ({
      field: issue.path.join(".") || "body",
      message: issue.message,
    })),
  );
}

function invalid(
  instance: string,
  fieldErrors: NonNullable<ConstructorParameters<typeof BillingHttpError>[4]>,
): BillingHttpError {
  return new BillingHttpError(
    400,
    "INVALID_BILLING_REQUEST",
    "Billing request validation failed",
    instance,
    fieldErrors,
  );
}
