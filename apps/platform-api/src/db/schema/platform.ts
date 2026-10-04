import { sql } from "drizzle-orm";
import {
  bigint,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  region: text("region").notNull().default("ap-south-1"),
  identityOrgRef: text("identity_org_ref"),
  dataResidency: jsonb("data_residency"),
  retentionOverrides: jsonb("retention_overrides"),
  securityPolicy: jsonb("security_policy"),
  ssoConfig: jsonb("sso_config"),
  billingProfileId: uuid("billing_profile_id"),
  createdAt,
  updatedAt,
});

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    status: text("status").notNull(),
    defaultModelPolicy: jsonb("default_model_policy"),
    defaultToolPolicy: jsonb("default_tool_policy"),
    budget: jsonb("budget"),
    safeguards: jsonb("safeguards")
      .notNull()
      .default({ contains_pii: true, approve_external_actions: true }),
    adsScopeId: uuid("ads_scope_id"),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("workspaces_tenant_id_name_unique").on(table.tenantId, table.name),
    uniqueIndex("workspaces_tenant_id_id_unique").on(table.tenantId, table.id),
  ],
);

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  identityRef: text("identity_ref").notNull(),
  email: text("email").notNull(),
  displayName: text("display_name"),
  status: text("status").notNull(),
  createdAt,
  updatedAt,
});

export const tenantMembers = pgTable(
  "tenant_members",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull(),
    createdAt,
  },
  (table) => [
    uniqueIndex("tenant_members_tenant_id_user_id_unique").on(
      table.tenantId,
      table.userId,
    ),
  ],
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull(),
    createdAt,
  },
  (table) => [
    uniqueIndex("workspace_members_workspace_id_user_id_unique").on(
      table.workspaceId,
      table.userId,
    ),
  ],
);

export const workspaceInvitations = pgTable("workspace_invitations", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id),
  workspaceId: uuid("workspace_id").notNull(),
  email: text("email").notNull(),
  role: text("role").notNull(),
  status: text("status").notNull().default("delivery_failed"),
  invitedBy: uuid("invited_by").notNull().references(() => users.id),
  providerOrgRef: text("provider_org_ref").notNull(),
  deliveryAttemptId: uuid("delivery_attempt_id"),
  providerInvitationId: text("provider_invitation_id"),
  providerTicketHash: text("provider_ticket_hash"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull().default(sql`now()+interval '7 days'`),
  acceptedBy: uuid("accepted_by").references(() => users.id),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt, updatedAt,
}, table => [
  foreignKey({ columns: [table.tenantId, table.workspaceId], foreignColumns: [workspaces.tenantId, workspaces.id], name: "workspace_invitations_workspace_fk" }),
  uniqueIndex("workspace_invitations_pending_email_unique").on(table.tenantId, table.workspaceId, table.email).where(sql`${table.status}='pending'`),
  uniqueIndex("workspace_invitations_ticket_unique").on(table.providerTicketHash).where(sql`${table.providerTicketHash} IS NOT NULL`),
]);

export const entitlements = pgTable("entitlements", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  plan: text("plan").notNull(),
  limits: jsonb("limits"),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }),
  effectiveTo: timestamp("effective_to", { withTimezone: true }),
  accessState: text("access_state").notNull().default("active"),
  createdAt,
});

export const onboardingStates = pgTable(
  "onboarding_states",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    steps: jsonb("steps").notNull(),
    currentStep: text("current_step"),
    status: text("status").notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("onboarding_states_workspace_id_unique").on(table.workspaceId),
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [workspaces.tenantId, workspaces.id],
      name: "onboarding_states_tenant_workspace_fk",
    }),
  ],
);

export const userSessions = pgTable("user_sessions", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  refreshTokenHash: text("refresh_token_hash").notNull(),
  accessTokenHash: text("access_token_hash").notNull(),
  deviceInfo: jsonb("device_info"),
  ip: text("ip"),
  createdAt,
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: jsonb("response_body").notNull(),
    createdAt,
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("idempotency_keys_tenant_key_unique").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    index("idempotency_keys_expires_at_idx").on(table.expiresAt),
  ],
);

export const credentialRefs = pgTable(
  "credential_refs",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    connector: text("connector").notNull(),
    scope: text("scope").notNull(),
    last4: text("last4").notNull(),
    useAuditPtr: uuid("use_audit_ptr"),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("credential_refs_tenant_id_id_unique").on(
      table.tenantId,
      table.id,
    ),
    index("credential_refs_tenant_created_at_idx").on(
      table.tenantId,
      table.createdAt,
    ),
  ],
);

export const credentialUseAudits = pgTable(
  "credential_use_audits",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    id: uuid("id").primaryKey(),
    credentialId: uuid("credential_id").notNull(),
    usedBy: uuid("used_by").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("credential_use_audits_tenant_credential_idx").on(
      table.tenantId,
      table.credentialId,
    ),
    foreignKey({
      columns: [table.tenantId, table.credentialId],
      foreignColumns: [credentialRefs.tenantId, credentialRefs.id],
      name: "credential_use_audits_tenant_credential_fk",
    }),
  ],
);

export const envVars = pgTable(
  "env_vars",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    id: uuid("id").primaryKey(),
    projectId: text("project_id").notNull(),
    environment: text("environment").notNull(),
    key: text("key").notNull(),
    last4: text("last4").notNull(),
    useAuditPtr: uuid("use_audit_ptr"),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("env_vars_tenant_id_id_unique").on(table.tenantId, table.id),
    uniqueIndex("env_vars_tenant_project_environment_key_unique").on(
      table.tenantId,
      table.projectId,
      table.environment,
      table.key,
    ),
    index("env_vars_tenant_project_created_at_idx").on(
      table.tenantId,
      table.projectId,
      table.createdAt,
    ),
  ],
);

export const envVarUseAudits = pgTable(
  "env_var_use_audits",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    id: uuid("id").primaryKey(),
    envVarId: uuid("env_var_id").notNull(),
    usedBy: text("used_by").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("env_var_use_audits_tenant_env_var_idx").on(
      table.tenantId,
      table.envVarId,
    ),
    foreignKey({
      columns: [table.tenantId, table.envVarId],
      foreignColumns: [envVars.tenantId, envVars.id],
      name: "env_var_use_audits_tenant_env_var_fk",
    }),
  ],
);

export const billingProfiles = pgTable(
  "billing_profiles",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    id: uuid("id").primaryKey(),
    providerId: text("provider_id").notNull(),
    providerCustomerRef: text("provider_customer_ref"),
    subscriptionRef: text("subscription_ref"),
    checkoutAttemptId: uuid("checkout_attempt_id"),
    gstin: text("gstin"),
    commercialSnapshot: jsonb("commercial_snapshot"),
    providerPlanRef: text("provider_plan_ref"),
    lastProviderEventAt: bigint("last_provider_event_at", { mode: "number" }).notNull().default(0),
    status: text("status").notNull(),
    currentPlan: text("current_plan"),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("billing_profiles_tenant_id_unique").on(table.tenantId),
    uniqueIndex("billing_profiles_tenant_id_id_unique").on(
      table.tenantId,
      table.id,
    ),
  ],
);

export const billingPaymentMethodRefs = pgTable(
  "billing_payment_method_refs",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    ref: text("ref").notNull(),
    type: text("type").notNull(),
    brand: text("brand"),
    last4: text("last4"),
    createdAt,
  },
  (table) => [
    uniqueIndex("billing_payment_method_refs_tenant_ref_unique").on(
      table.tenantId,
      table.ref,
    ),
  ],
);

export const billingEvents = pgTable(
  "billing_events",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    providerId: text("provider_id").notNull(),
    providerEventId: text("provider_event_id").notNull().unique(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt,
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("billing_events_tenant_provider_event_unique").on(
      table.tenantId,
      table.providerEventId,
    ),
  ],
);

export const billingDunningStates = pgTable("billing_dunning_states", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id),
  state: text("state").notNull().default("active"),
  currentPlan: text("current_plan"),
  firstFailedAt: timestamp("first_failed_at", { withTimezone: true }),
  updatedAt,
});

export const billingDunningAudits = pgTable(
  "billing_dunning_audits",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    id: uuid("id").primaryKey(),
    providerEventId: text("provider_event_id").notNull(),
    fromState: text("from_state").notNull(),
    toState: text("to_state").notNull(),
    reason: text("reason").notNull(),
    actorRef: text("actor_ref"),
    createdAt,
  },
  (table) => [
    index("billing_dunning_audits_tenant_created_at_idx").on(
      table.tenantId,
      table.createdAt,
    ),
  ],
);
