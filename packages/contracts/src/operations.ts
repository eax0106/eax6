import { z } from "./zod";
import { DeploymentIdSchema, IsoTimestampSchema, ProjectIdSchema, TenantIdSchema } from "./ids";
import { ModelAliasBindingSchema, ModelAliasSchema } from "./model-alias-policy";

export const PlatformTenantIdSchema = z.string().uuid();
export const StaffAccessScopeSchema = z.enum([
  "tenant:read",
  "audit:read",
  "workflows:read",
  "runs:read",
  "billing:read",
]);

export const CreateJitGrantRequestSchema = z
  .object({
    staff_user_id: z.string().regex(/^stf_[a-z0-9._:-]{1,127}$/i),
    tenant_id: PlatformTenantIdSchema,
    reason_code: z.string().trim().min(1).max(100),
    reason_text: z.string().trim().min(1).max(1_000),
    duration_minutes: z.number().int().min(1).max(480),
    scopes: z.array(StaffAccessScopeSchema).min(1).max(10),
  })
  .strict();

export const ProviderHealthStatusSchema = z.enum([
  "healthy",
  "degraded",
  "unhealthy",
]);
export const ProviderControlSchema = z
  .object({
    provider_id: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{1,127}$/),
    interface_name: z.string().trim().min(1).max(128),
    health: ProviderHealthStatusSchema,
    checked_at: IsoTimestampSchema,
    latency_ms: z.number().int().nonnegative(),
    active: z.boolean(),
    configuration_revision: z.string().trim().min(1).max(256),
    fallback_chain: z.array(z.string().trim().min(1).max(128)).max(10),
  })
  .strict();
export const UpdateProviderControlRequestSchema = z
  .object({
    active: z.boolean().optional(),
    fallback_chain: z
      .array(z.string().trim().min(1).max(128))
      .max(10)
      .optional(),
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict()
  .refine(
    (value) => value.active !== undefined || value.fallback_chain !== undefined,
    "At least one provider control must be supplied",
  );

export const FeatureFlagNameSchema = z.string().trim().regex(/^[a-z][a-z0-9._-]{1,127}$/);
export const FeatureFlagSchema = z.object({
  name: FeatureFlagNameSchema,
  enabled: z.boolean(),
  description: z.string().trim().min(1).max(500),
  revision: z.number().int().positive(),
  updated_at: IsoTimestampSchema,
  updated_by: z.string().trim().min(1),
}).strict();
export const UpsertFeatureFlagRequestSchema = z.object({
  enabled: z.boolean(),
  description: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(1_000),
}).strict();
export const UpdateModelAliasRequestSchema = z.object({
  binding: ModelAliasBindingSchema,
  reason: z.string().trim().min(1).max(1_000),
}).strict();
export const ModelAliasPathSchema = ModelAliasSchema;

export const IncidentSeveritySchema = z.enum(["sev1", "sev2", "sev3"]);
export const IncidentStatusSchema = z.enum([
  "draft",
  "investigating",
  "monitoring",
  "resolved",
]);
export const IncidentPublicationStateSchema = z.enum([
  "not_requested",
  "pending_approval",
  "approved",
  "publishing",
  "published",
  "rejected",
]);
export const CreateIncidentRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(4_000),
    severity: IncidentSeveritySchema,
    impacted_services: z.array(z.string().trim().min(1).max(128)).min(1).max(50),
  })
  .strict();
export const IncidentApprovalRequestSchema = z
  .object({ reason: z.string().trim().min(1).max(1_000) })
  .strict();
export const IncidentIdSchema = z.string().regex(/^inc_[0-9a-f-]{36}$/i);
export const AdminIncidentSchema = z
  .object({
    id: IncidentIdSchema,
    title: z.string(),
    summary: z.string(),
    severity: IncidentSeveritySchema,
    impacted_services: z.array(z.string()),
    status: IncidentStatusSchema,
    publication_state: IncidentPublicationStateSchema,
    created_by: z.string(),
    created_at: IsoTimestampSchema,
    publication_requested_by: z.string().nullable(),
    publication_requested_at: IsoTimestampSchema.nullable(),
    approved_by: z.string().nullable(),
    approved_at: IsoTimestampSchema.nullable(),
    provider_incident_ref: z.string().nullable(),
    published_at: IsoTimestampSchema.nullable(),
  })
  .strict();

export const RefundPaymentRequestSchema = z
  .object({
    payment_ref: z.string().trim().min(1).max(256),
    amount_minor: z.number().int().positive(),
    speed: z.enum(["normal", "optimum"]).default("normal"),
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();
export const ResolveDisputeRequestSchema = z
  .object({
    action: z.enum(["accept", "contest"]),
    reason: z.string().trim().min(1).max(1_000),
    evidence_refs: z
      .array(z.string().trim().regex(/^doc_[A-Za-z0-9]+$/).max(512))
      .max(20)
      .default([]),
  })
  .strict()
  .refine(
    (value) => value.action !== "contest" || value.evidence_refs.length > 0,
    "At least one evidence reference is required to contest a dispute",
  );

export const AbuseSignalSchema = z
  .object({
    id: z.string().regex(/^abs_[0-9a-f-]{36}$/i),
    tenant_id: PlatformTenantIdSchema,
    signal_type: z.enum([
      "payment_fraud",
      "free_tier_velocity",
      "credential_abuse",
      "marketplace_supply_chain",
    ]),
    source: z.string().trim().min(1).max(128),
    score: z.number().min(0).max(100),
    evidence_ref: z.string().trim().min(1).max(512),
    observed_at: IsoTimestampSchema,
    status: z.enum(["open", "confirmed", "dismissed"]),
  })
  .strict();
export const ReviewAbuseSignalRequestSchema = z
  .object({
    decision: z.enum(["confirm", "dismiss"]),
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const DeploymentAdminActionRequestSchema = z
  .object({
    tenant_id: PlatformTenantIdSchema,
    deployment_id: DeploymentIdSchema,
    action: z.enum(["rollback", "suspend", "resume"]),
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();
export const DeploymentAdminActionResultSchema = z
  .object({
    tenant_id: PlatformTenantIdSchema,
    deployment_id: DeploymentIdSchema,
    project_id: ProjectIdSchema,
    action: z.enum(["rollback", "suspend", "resume"]),
    status: z.enum(["active", "rolled_back", "suspended"]),
    active_deployment_id: DeploymentIdSchema.nullable(),
    updated_at: IsoTimestampSchema,
  })
  .strict();

export const MarketplaceGovernanceActionRequestSchema = z
  .object({
    action: z.enum(["approve", "reject", "needs_changes", "takedown", "restore", "set_trust"]),
    reason: z.string().trim().min(1).max(1_000),
    trust_level: z
      .enum([
        "alter_verified",
        "verified_publisher",
        "community_reviewed",
        "unverified_private",
        "blocked",
      ])
      .optional(),
  })
  .strict()
  .refine(
    (value) => value.action === "set_trust" ? value.trust_level !== undefined : value.trust_level === undefined,
    "trust_level is required only for set_trust",
  );
export const MarketplaceGovernanceResourceTypeSchema = z.enum([
  "listing",
  "tool_manifest",
]);
export const MarketplaceGovernanceItemSchema = z.object({
  resource_type: MarketplaceGovernanceResourceTypeSchema,
  id: z.string().trim().min(1).max(128),
  tenant_id: z.union([PlatformTenantIdSchema, TenantIdSchema]).nullable(),
  name: z.string().trim().min(1).max(255),
  description: z.string().nullable().optional(),
  status: z.string().trim().min(1).max(64),
  trust_level: z.string().trim().min(1).max(64).nullable(),
  updated_at: IsoTimestampSchema,
  etag: z.string().min(1).optional(),
  risk: z.object({score: z.number().int().min(0).max(100), incomplete: z.boolean(),
    reasons: z.array(z.object({signal: z.enum(["scanner", "first_listing", "outside_actions", "account_scopes", "prior_takedowns"]),
      points: z.number().int().nonnegative(), detail: z.string(), evidence: z.array(z.string()), observed: z.boolean()}).strict()),
  }).strict().optional(),
  review_notes: z.array(z.object({id: z.string(), actor_type: z.enum(["staff", "seller"]), actor_ref: z.string(),
    action: z.enum(["approve", "reject", "needs_changes", "takedown", "restore", "set_trust", "resubmit", "edit"]),
    previous_status: z.string(), next_status: z.string(), reason: z.string(), occurred_at: IsoTimestampSchema,
  }).strict()).optional(),
}).strict();

export type StaffAccessScope = z.infer<typeof StaffAccessScopeSchema>;
export type CreateJitGrantRequest = z.infer<typeof CreateJitGrantRequestSchema>;
export type ProviderControl = z.infer<typeof ProviderControlSchema>;
export type UpdateProviderControlRequest = z.infer<typeof UpdateProviderControlRequestSchema>;
export type FeatureFlag = z.infer<typeof FeatureFlagSchema>;
export type UpsertFeatureFlagRequest = z.infer<typeof UpsertFeatureFlagRequestSchema>;
export type UpdateModelAliasRequest = z.infer<typeof UpdateModelAliasRequestSchema>;
export type CreateIncidentRequest = z.infer<typeof CreateIncidentRequestSchema>;
export type IncidentApprovalRequest = z.infer<typeof IncidentApprovalRequestSchema>;
export type AdminIncident = z.infer<typeof AdminIncidentSchema>;
export type RefundPaymentRequest = z.infer<typeof RefundPaymentRequestSchema>;
export type ResolveDisputeRequest = z.infer<typeof ResolveDisputeRequestSchema>;
export type AbuseSignal = z.infer<typeof AbuseSignalSchema>;
export type ReviewAbuseSignalRequest = z.infer<typeof ReviewAbuseSignalRequestSchema>;
export type DeploymentAdminActionRequest = z.infer<typeof DeploymentAdminActionRequestSchema>;
export type DeploymentAdminActionResult = z.infer<typeof DeploymentAdminActionResultSchema>;
export type MarketplaceGovernanceActionRequest = z.infer<typeof MarketplaceGovernanceActionRequestSchema>;
export type MarketplaceGovernanceResourceType = z.infer<typeof MarketplaceGovernanceResourceTypeSchema>;
export type MarketplaceGovernanceItem = z.infer<typeof MarketplaceGovernanceItemSchema>;
