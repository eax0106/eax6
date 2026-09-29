import { z } from "./zod";
import {
  NonEmptyStringSchema,
  ServiceActorIdSchema,
  TenantIdSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from "./ids";

const NumericDateSchema = z.number().int().nonnegative();

export const ActorTokenClaimsSchema = z
  .object({
    user_id: z.union([UserIdSchema, ServiceActorIdSchema]),
    tenant_id: TenantIdSchema,
    workspace_id: WorkspaceIdSchema,
    roles: z.array(NonEmptyStringSchema),
    permissions: z.array(NonEmptyStringSchema),
    session_id: NonEmptyStringSchema,
    auth_time: NumericDateSchema,
    jti: NonEmptyStringSchema,
    iss: NonEmptyStringSchema,
    aud: NonEmptyStringSchema,
    iat: NumericDateSchema,
    exp: NumericDateSchema,
  })
  .strict()
  .superRefine(({ auth_time, iat, exp }, context) => {
    if (auth_time > iat) {
      context.addIssue({
        code: "custom",
        message: "auth_time must not be later than iat",
        path: ["auth_time"],
      });
    }

    if (exp <= iat || exp - iat > 300) {
      context.addIssue({
        code: "custom",
        message: "Actor token lifetime must be positive and no more than 300 seconds",
        path: ["exp"],
      });
    }
  })
  .describe(
    "Alter-owned signed delegation JWT claims. Never include secrets or model M2M bearer-token claims.",
  );

export type ActorTokenClaims = z.infer<typeof ActorTokenClaimsSchema>;

/**
 * The one system principal (D1, design log §30 amendment): platform-api's own
 * background jobs, acting with no user signed in. Named so the engine can
 * record it in its audit; never derived from a request.
 */
export const SYSTEM_PLATFORM_JOBS_PRINCIPAL = "system:platform-jobs" as const;

/**
 * The fixed permission set of `system:platform-jobs`: read-only, and only the
 * reads a background job needs (run, workflow, approval, connection, cost and
 * budget state). A system token carrying anything else is refused.
 */
export const SYSTEM_PLATFORM_JOBS_PERMISSIONS = [
  "runs:read",
  "workflows:read",
  "projects:read",
  "human-actions:read",
  "integrations:read",
  "billing:read",
  "budgets:read",
] as const;

export const SystemActorTokenClaimsSchema = z
  .object({
    principal_type: z.literal("system"),
    principal: z.literal(SYSTEM_PLATFORM_JOBS_PRINCIPAL),
    tenant_id: TenantIdSchema,
    permissions: z
      .array(z.enum(SYSTEM_PLATFORM_JOBS_PERMISSIONS))
      .min(1),
    auth_time: NumericDateSchema,
    jti: NonEmptyStringSchema,
    iss: NonEmptyStringSchema,
    aud: NonEmptyStringSchema,
    iat: NumericDateSchema,
    exp: NumericDateSchema,
  })
  .strict()
  .superRefine(({ auth_time, iat, exp }, context) => {
    if (auth_time > iat) {
      context.addIssue({
        code: "custom",
        message: "auth_time must not be later than iat",
        path: ["auth_time"],
      });
    }

    if (exp <= iat || exp - iat > 300) {
      context.addIssue({
        code: "custom",
        message: "Actor token lifetime must be positive and no more than 300 seconds",
        path: ["exp"],
      });
    }
  })
  .describe(
    "Delegation JWT claims of a system principal (no user, no workspace, one tenant, fixed read-only permissions).",
  );

export type SystemActorTokenClaims = z.infer<typeof SystemActorTokenClaimsSchema>;
