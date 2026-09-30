/**
 * Deletion & Retention registry (task C3; design log §18, §28). Every table in
 * every database this system runs is named here exactly once: either as
 * tenant data, with the erasure route that reaches it, or as an exemption
 * with a reason. scripts/deletion/certify.ts checks it in CI against schemas
 * built from each service's real migrations, in both directions, and checks
 * each provider route against that provider's own table list.
 *
 * Lives in code, not a database table: a row does not appear in a pull
 * request diff, and this list decides whether erasure can reach data.
 *
 * A route of kind "gap" is tenant data that no erasure path reaches today. It
 * is declared -- so it is visible and counted -- not hidden; closing a gap
 * means building the provider and changing the route. The number of gaps is
 * held by `MAX_ERASURE_GAPS` so it can only fall.
 */

export type DatabaseName =
  | "platform_db"
  | "orchestration_db"
  | "audit_db"
  | "cost_db"
  | "ads_db"
  | "intelligence_db"
  | "policy_db"
  | "eval_db";

/** The services whose erasure provider the audit-service DeletionOrchestrator calls. */
export type ErasureProvider = "orchestration-service" | "ads-core" | "platform-api" | "cost-ledger-service" | "intelligence-service" | "memory-service";

export type ErasureRoute =
  | { readonly kind: "provider"; readonly provider: ErasureProvider }
  | { readonly kind: "gap"; readonly note: string };

export interface TenantDataDeclaration {
  readonly database: DatabaseName;
  readonly schema: string;
  readonly table: string;
  /** The service that owns the table. */
  readonly owner: string;
  readonly erasure: ErasureRoute;
}

export interface TenantDataExemption {
  readonly database: DatabaseName;
  readonly schema: string;
  readonly table: string;
  /** Required. A reason can be reviewed; silence cannot. */
  readonly reason: string;
  readonly owner: string;
}

export const tenantDataDeclarations: readonly TenantDataDeclaration[] = [
  { database: "platform_db", schema: "public", table: "abuse_signals", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "action_item_annotations", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "billing_dunning_audits", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "billing_dunning_states", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "billing_events", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "billing_payment_method_refs", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "billing_profiles", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "budgets", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "credential_refs", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "credential_use_audits", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "discovery_recommendations", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "entitlements", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "env_var_use_audits", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "env_vars", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "idempotency_keys", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "installs", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "jit_grant_audit", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "jit_grants", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "kyc_submissions", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "listing_versions", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "listings", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "notification_digests", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "notification_events", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "notification_preferences", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "notification_reads", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "oauth_connection_use_audits", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "oauth_connections", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "oauth_states", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "onboarding_states", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "orders", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "payout_ledger", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "payouts", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "publishers", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "repository_bindings", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "reviews", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "tenant_admin_actions", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "tenant_members", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "tenants", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "tool_manifests", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "tool_revocations", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "tool_scan_reports", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "tool_versions", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "user_admin_actions", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "user_sessions", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "users", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "workflow_safeguards", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "workspace_connector_configs", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "workspace_members", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "platform_db", schema: "public", table: "workspaces", owner: "platform-api", erasure: { kind: "provider", provider: "platform-api" } },
  { database: "orchestration_db", schema: "public", table: "budget_reservations", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "budget_usage", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "budgets", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "approvals", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "artifacts", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "blackboard_checkpoints", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "clarifications", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "conversation_goal_states", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "conversations", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "deployments", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "escalations", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "events", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "node_executions", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "project_plans", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "projects", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "recovery_actions", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "run_dispatch_queue", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "run_outcomes", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "run_stream_events", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "runs", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "trigger_integration_bindings", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "trigger_versions", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "trigger_webhook_secrets", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "triggers", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "verification_results", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "side_effects", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "webhook_endpoint_secrets", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "webhook_endpoints", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "whatsapp_accounts", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "workflow_template_variable_definitions", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "workflow_template_variable_values", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "workflow_versions", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "orchestration_db", schema: "public", table: "workflows", owner: "orchestration-service", erasure: { kind: "provider", provider: "orchestration-service" } },
  { database: "audit_db", schema: "public", table: "audit_events", owner: "audit-service", erasure: { kind: "gap", note: "Audit events are kept for chain integrity as a minimised skeleton under a tenant pseudonym (D2: 90 days after erasure, then destroyed); destroying chained rows needs a chain-compaction design that is not built yet." } },
  { database: "cost_db", schema: "public", table: "billing_rollups", owner: "cost-ledger-service", erasure: { kind: "provider", provider: "cost-ledger-service" } },
  { database: "cost_db", schema: "public", table: "cost_events", owner: "cost-ledger-service", erasure: { kind: "provider", provider: "cost-ledger-service" } },
  { database: "cost_db", schema: "public", table: "model_outcomes", owner: "cost-ledger-service", erasure: { kind: "provider", provider: "cost-ledger-service" } },
  { database: "cost_db", schema: "public", table: "run_verdicts", owner: "cost-ledger-service", erasure: { kind: "provider", provider: "cost-ledger-service" } },
  { database: "ads_db", schema: "public", table: "chunks", owner: "ads-core", erasure: { kind: "provider", provider: "ads-core" } },
  { database: "ads_db", schema: "public", table: "document_versions", owner: "ads-core", erasure: { kind: "provider", provider: "ads-core" } },
  { database: "ads_db", schema: "public", table: "documents", owner: "ads-core", erasure: { kind: "provider", provider: "ads-core" } },
  { database: "ads_db", schema: "public", table: "ingestion_jobs", owner: "ads-core", erasure: { kind: "provider", provider: "ads-core" } },
  { database: "ads_db", schema: "public", table: "memory_namespace", owner: "ads-core", erasure: { kind: "provider", provider: "ads-core" } },
  { database: "ads_db", schema: "public", table: "records", owner: "ads-core", erasure: { kind: "provider", provider: "ads-core" } },
  { database: "ads_db", schema: "public", table: "retrieval_audit", owner: "ads-core", erasure: { kind: "provider", provider: "ads-core" } },
  { database: "ads_db", schema: "public", table: "scopes", owner: "ads-core", erasure: { kind: "provider", provider: "ads-core" } },
  { database: "ads_db", schema: "public", table: "sources", owner: "ads-core", erasure: { kind: "provider", provider: "ads-core" } },
  { database: "intelligence_db", schema: "public", table: "agent_versions", owner: "intelligence-service", erasure: { kind: "provider", provider: "intelligence-service" } },
  { database: "intelligence_db", schema: "public", table: "agents", owner: "intelligence-service", erasure: { kind: "provider", provider: "intelligence-service" } },
  { database: "intelligence_db", schema: "public", table: "capability_embeddings", owner: "intelligence-service", erasure: { kind: "provider", provider: "intelligence-service" } },
  { database: "intelligence_db", schema: "public", table: "capability_registry_versions", owner: "intelligence-service", erasure: { kind: "provider", provider: "intelligence-service" } },
  { database: "intelligence_db", schema: "public", table: "performance_records", owner: "intelligence-service", erasure: { kind: "provider", provider: "intelligence-service" } },
  { database: "policy_db", schema: "public", table: "drift_scores", owner: "memory-service", erasure: { kind: "provider", provider: "memory-service" } },
  { database: "policy_db", schema: "public", table: "memory_records", owner: "memory-service", erasure: { kind: "provider", provider: "memory-service" } },
  { database: "policy_db", schema: "public", table: "policies", owner: "memory-service", erasure: { kind: "provider", provider: "memory-service" } },
  { database: "policy_db", schema: "public", table: "policy_promotions", owner: "memory-service", erasure: { kind: "provider", provider: "memory-service" } },
];

export const tenantDataExemptions: readonly TenantDataExemption[] = [
  { database: "platform_db", schema: "drizzle", table: "__drizzle_migrations", owner: "platform-api", reason: "Migration bookkeeping: applied migration hashes only." },
  { database: "platform_db", schema: "public", table: "admin_incidents", owner: "platform-api", reason: "Platform incidents published by staff; no tenant rows." },
  { database: "platform_db", schema: "public", table: "feature_flags", owner: "platform-api", reason: "Platform-wide flags set by staff; no tenant rows." },
  { database: "platform_db", schema: "public", table: "i18n_bundles", owner: "platform-api", reason: "Product translation strings; no tenant rows." },
  { database: "platform_db", schema: "public", table: "legal_hold_records", owner: "platform-api", reason: "What the law requires kept after a tenant is erased, reduced to minimum fields and keyed by a pseudonym; no tenant column. Destroyed by the retention sweeper when its retain_until passes (D2)." },
  { database: "platform_db", schema: "public", table: "tenant_erasure_manifests", owner: "platform-api", reason: "One identifier-only row per erasure run (manifest id, tenant id, secret paths still to delete). Destroyed with the tenant tombstone at the 90-day sweep (D2)." },
  { database: "platform_db", schema: "public", table: "marketplace_migrations", owner: "platform-api", reason: "Migration bookkeeping for the marketplace schema." },
  { database: "platform_db", schema: "public", table: "plan_definition_audit", owner: "platform-api", reason: "Staff changes to Alter's plan catalogue; no tenant rows." },
  { database: "platform_db", schema: "public", table: "plan_definitions", owner: "platform-api", reason: "Alter's plan catalogue (limits per plan); no tenant rows." },
  { database: "platform_db", schema: "public", table: "staff_users", owner: "platform-api", reason: "Alter's own staff accounts, not a customer's data." },
  { database: "orchestration_db", schema: "drizzle", table: "__drizzle_migrations", owner: "orchestration-service", reason: "Migration bookkeeping: applied migration hashes only." },
  { database: "audit_db", schema: "drizzle", table: "__drizzle_migrations", owner: "audit-service", reason: "Migration bookkeeping: applied migration hashes only." },
  { database: "audit_db", schema: "public", table: "audit_chain_checkpoints", owner: "audit-service", reason: "Hash-chain integrity checkpoints: a hash and a count, no tenant data." },
  { database: "audit_db", schema: "public", table: "deletion_certificates", owner: "audit-service", reason: "Proof that an erasure happened, keyed by an HMAC pseudonym of the tenant, never the tenant id." },
  { database: "audit_db", schema: "public", table: "deletion_ledger", owner: "audit-service", reason: "Replay ledger of completed erasures, keyed by an HMAC pseudonym only." },
  { database: "cost_db", schema: "drizzle", table: "__drizzle_migrations", owner: "cost-ledger-service", reason: "Migration bookkeeping: applied migration hashes only." },
  { database: "cost_db", schema: "public", table: "model_pricing", owner: "cost-ledger-service", reason: "Provider unit prices; Alter's own reference data." },
  { database: "ads_db", schema: "public", table: "alembic_version", owner: "ads-core", reason: "Migration bookkeeping: the applied revision only." },
  { database: "intelligence_db", schema: "public", table: "alembic_version", owner: "intelligence-service", reason: "Migration bookkeeping: the applied revision only." },
  { database: "policy_db", schema: "public", table: "alembic_version", owner: "memory-service", reason: "Migration bookkeeping: the applied revision only." },
  { database: "eval_db", schema: "public", table: "alembic_version", owner: "eval-service", reason: "Migration bookkeeping: the applied revision only." },
  { database: "eval_db", schema: "public", table: "eval_cases", owner: "eval-service", reason: "Alter's own golden-set cases, not customer data." },
  { database: "eval_db", schema: "public", table: "eval_results", owner: "eval-service", reason: "Results of Alter's own golden-set runs." },
  { database: "eval_db", schema: "public", table: "eval_runs", owner: "eval-service", reason: "Alter's own evaluation runs." },
  { database: "eval_db", schema: "public", table: "golden_sets", owner: "eval-service", reason: "Alter's own golden sets." },
  { database: "eval_db", schema: "public", table: "redteam_results", owner: "eval-service", reason: "Alter's own red-team suite results." },
  { database: "eval_db", schema: "public", table: "release_gates", owner: "eval-service", reason: "Alter's release gate decisions." },
];

/**
 * Tenant tables no erasure path reaches, today. certify.ts fails when the
 * count rises above this; lower it in the same change that closes a gap.
 */
// 63 since C5 (2026-09-28): run_verdicts is new billing evidence in a
// service that has no erasure provider yet; it is counted here rather than
// hidden, and falls with the rest when C3b lands.
export const MAX_ERASURE_GAPS = 1;
