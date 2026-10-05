import { z } from "zod";
import { ENTITLEMENT_LIMIT_KEYS } from "../entitlements/types";
import { AdminTenantHttpError } from "./problem";
import type {
  EntitlementOverrideInput,
  ProvisionTenantInput,
  SuspendTenantInput,
} from "./types";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const provisionSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    identity_org_ref: z.string().trim().min(1).max(200),
    region: z.string().trim().min(1).max(50).optional(),
    plan: z.string().trim().min(1).max(100),
  })
  .strict();

const noteSchema = z.object({ body: z.string().trim().min(1).max(4000) }).strict();

const suspendSchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

const limitsSchema = z
  .object(
    Object.fromEntries(
      ENTITLEMENT_LIMIT_KEYS.map((key) => [key, z.number().nonnegative().optional()]),
    ),
  )
  .strict();

const entitlementOverrideSchema = z
  .object({
    plan: z.string().trim().min(1).max(100).optional(),
    limits: limitsSchema.optional(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export function parseTenantNoteInput(value: unknown, instance: string): {body: string} {
  return parse(noteSchema, value, instance);
}

export function parseTenantId(value: string, instance: string): string {
  if (!uuidPattern.test(value)) {
    throw validationError(instance, [
      { field: "tenantId", message: "Invalid tenantId" },
    ]);
  }
  return value;
}

export function parseProvisionTenantInput(
  value: unknown,
  instance: string,
): ProvisionTenantInput {
  return parse(provisionSchema, value, instance);
}

export function parseSuspendTenantInput(
  value: unknown,
  instance: string,
): SuspendTenantInput {
  return parse(suspendSchema, value, instance);
}

export function parseEntitlementOverrideInput(
  value: unknown,
  instance: string,
): EntitlementOverrideInput {
  return parse(entitlementOverrideSchema, value, instance);
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
): AdminTenantHttpError {
  return new AdminTenantHttpError(
    400,
    "ADMIN_TENANT_VALIDATION_FAILED",
    "Admin tenant request validation failed",
    instance,
    fieldErrors,
  );
}
