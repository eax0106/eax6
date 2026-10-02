import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ORCHESTRATION_MIGRATIONS_PATH } from "./migrations-path";

const migrationFiles = readdirSync(ORCHESTRATION_MIGRATIONS_PATH)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const migrationSql = migrationFiles.map((file) => ({
  file,
  sql: readFileSync(resolve(ORCHESTRATION_MIGRATIONS_PATH, file), "utf8").replace(/\r\n/g, "\n"),
}));
const migrationJournal = JSON.parse(
  readFileSync(resolve(ORCHESTRATION_MIGRATIONS_PATH, "meta", "_journal.json"), "utf8"),
) as { readonly entries: readonly { readonly tag: string }[] };

describe("orchestration migration files", () => {
  it("keeps ordered migrations and matching rollbacks", () => {
    expect(migrationFiles).toEqual([
      "0000_create_workflows.sql",
      "0001_create_triggers.sql",
      "0002_create_trigger_versions.sql",
      "0003_create_conversations.sql",
      "0004_create_events.sql",
      "0005_create_runs.sql",
      "0006_create_conversation_goal_states.sql",
      "0007_create_workflow_versions.sql",
      "0008_add_workflow_version_canary_traffic.sql",
      "0009_create_blackboard_checkpoints.sql",
      "0010_create_node_executions.sql",
      "0011_create_run_stream_events.sql",
      "0012_add_run_workflow_version.sql",
      "0013_create_verification_results.sql",
      "0014_create_recovery_actions.sql",
      "0015_create_run_outcomes.sql",
      "0016_create_approvals.sql",
      "0017_allow_pending_recovery_policy.sql",
      "0018_add_blocked_pending_recovery_status.sql",
      "0019_create_projects.sql",
      "0020_create_artifacts.sql",
      "0021_create_whatsapp_accounts.sql",
      "0022_add_project_run_provisioning.sql",
      "0023_add_deployment_artifact_seam.sql",
      "0024_create_template_variables_clarifications.sql",
      "0025_create_trigger_integration_bindings.sql",
      "0026_create_escalations.sql",
      "0027_create_trigger_webhook_secrets.sql",
      "0028_create_project_plans.sql",
      "0029_add_deployment_suspended_status.sql",
      "0030_add_workflow_paused_status.sql",
      "0031_add_workflow_draft_dag.sql",
      "0032_add_run_triggering_event.sql",
      "0033_add_run_deadline.sql",
      "0034_create_run_dispatch_queue.sql",
      "0035_add_workflow_version_test_gate.sql",
      "0036_add_workflow_version_task_skeleton.sql",
      "0037_drop_workflow_version_requirements_columns.sql",
      "0038_remove_voice_conversation_channel.sql",
      "0039_run_owner_tenant.sql",
      "0040_create_side_effects.sql",
      "0041_create_budgets.sql",
      "0042_restrict_webhook_resolver_rls.sql",
      "0043_workflow_version_deploy_marks.sql",
      "0044_create_workspace_holds.sql",
      "0045_create_workspace_run_retention.sql",
      "0046_create_approval_step_policies.sql",
      "0047_add_email_delivery_readback.sql",
      "0048_add_recovery_clarifications.sql",
      "0050_create_connection_registry.sql",
    ]);
    expect(
      readdirSync(resolve(ORCHESTRATION_MIGRATIONS_PATH, "rollback"))
        .filter((file) => file.endsWith(".sql"))
        .sort(),
    ).toEqual([
      "0000_drop_workflows.sql",
      "0001_drop_triggers.sql",
      "0002_drop_trigger_versions.sql",
      "0003_drop_conversations.sql",
      "0004_drop_events.sql",
      "0005_drop_runs.sql",
      "0006_drop_conversation_goal_states.sql",
      "0007_drop_workflow_versions.sql",
      "0008_remove_workflow_version_canary_traffic.sql",
      "0009_drop_blackboard_checkpoints.sql",
      "0010_drop_node_executions.sql",
      "0011_drop_run_stream_events.sql",
      "0012_remove_run_workflow_version.sql",
      "0013_drop_verification_results.sql",
      "0014_drop_recovery_actions.sql",
      "0015_drop_run_outcomes.sql",
      "0016_drop_approvals.sql",
      "0017_require_recovery_policy.sql",
      "0018_remove_blocked_pending_recovery_status.sql",
      "0019_drop_projects.sql",
      "0020_drop_artifacts.sql",
      "0021_drop_whatsapp_accounts.sql",
      "0022_remove_project_run_provisioning.sql",
      "0023_remove_deployment_artifact_seam.sql",
      "0024_drop_template_variables_clarifications.sql",
      "0025_drop_trigger_integration_bindings.sql",
      "0026_drop_escalations.sql",
      "0027_drop_trigger_webhook_secrets.sql",
      "0028_drop_project_plans.sql",
      "0029_remove_deployment_suspended_status.sql",
      "0030_remove_workflow_paused_status.sql",
      "0031_remove_workflow_draft_dag.sql",
      "0032_remove_run_triggering_event.sql",
      "0033_remove_run_deadline.sql",
      "0034_drop_run_dispatch_queue.sql",
      "0035_remove_workflow_version_test_gate.sql",
      "0036_remove_workflow_version_task_skeleton.sql",
      "0037_restore_workflow_version_requirements_columns.sql",
      "0038_restore_voice_conversation_channel.sql",
      "0039_drop_run_owner_tenant.sql",
      "0040_drop_side_effects.sql",
      "0041_drop_budgets.sql",
      "0042_restore_webhook_resolver.sql",
      "0043_drop_workflow_version_deploy_marks.sql",
      "0044_drop_workspace_holds.sql",
      "0045_drop_workspace_run_retention.sql",
      "0046_drop_approval_step_policies.sql",
      "0047_remove_email_delivery_readback.sql",
      "0048_remove_recovery_clarifications.sql",
      "0050_drop_connection_registry.sql",
    ]);
  });

  it("registers every migration in Drizzle journal so production migration runs cannot skip it", () => {
    expect(migrationJournal.entries.map((entry) => `${entry.tag}.sql`)).toEqual(
      migrationFiles,
    );
  });

  it.each(migrationSql.filter(({ sql }) => sql.includes("CREATE TABLE")))(
    "$file forces default-deny RLS and tenant immutability",
    ({ sql }) => {
      expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
      expect(sql).toContain("FORCE ROW LEVEL SECURITY");
      expect(sql).toContain("reject_tenant_id_change()");
      expect(sql).toContain(
        "NULLIF(current_setting('app.current_tenant_id', true), '')::uuid",
      );
      expect(sql).toContain("WITH CHECK");
    },
  );

  it("defines immutability function once and reuses it thirty-five times", () => {
    const allSql = migrationSql.map(({ sql }) => sql).join("\n");

    expect(allSql.match(/CREATE OR REPLACE FUNCTION reject_tenant_id_change/g))
      .toHaveLength(1);
    expect(allSql.match(/EXECUTE FUNCTION reject_tenant_id_change\(\)/g))
      .toHaveLength(35);
  });

  it("persists a bounded traffic percentage only for canary versions", () => {
    const canaryMigration = migrationSql.find(
      ({ file }) => file === "0008_add_workflow_version_canary_traffic.sql",
    )?.sql;

    expect(canaryMigration).toContain('ADD COLUMN "traffic_percent" integer');
    expect(canaryMigration).toContain(
      'CONSTRAINT "workflow_versions_canary_traffic_check"',
    );
    expect(canaryMigration).toContain(
      '"status" = \'canary\' AND "traffic_percent" BETWEEN 1 AND 99',
    );
    expect(canaryMigration).toContain(
      '"status" <> \'canary\' AND "traffic_percent" IS NULL',
    );
  });

  it("maps tested versions before removing their evidence constraint", () => {
    const rollback = readFileSync(
      resolve(ORCHESTRATION_MIGRATIONS_PATH, "rollback", "0035_remove_workflow_version_test_gate.sql"),
      "utf8",
    );
    expect(rollback.indexOf("UPDATE workflow_versions SET status = 'compiled' WHERE status = 'tested'"))
      .toBeLessThan(rollback.indexOf("DROP CONSTRAINT workflow_versions_status_check"));
    expect(rollback).toContain("DROP CONSTRAINT workflow_versions_tested_evidence_check");
  });

  it("contains no cross-database references", () => {
    const allSql = migrationSql.map(({ sql }) => sql).join("\n");

    expect(allSql).not.toMatch(/platform_db|marketplace_db|audit_db/i);
  });

  it("keeps required dedup and relationship constraints", () => {
    const allSql = migrationSql.map(({ sql }) => sql).join("\n");

    expect(allSql).toContain(
      'CREATE UNIQUE INDEX "idx_events_tenant_idempotency"',
    );
    expect(allSql).toContain(
      'CONSTRAINT "triggers_workflow_tenant_fk" FOREIGN KEY ("tenant_id", "workflow_id") REFERENCES "workflows"("tenant_id", "id")',
    );
    expect(allSql).toContain(
      'CONSTRAINT "trigger_versions_trigger_tenant_fk" FOREIGN KEY ("tenant_id", "trigger_id") REFERENCES "triggers"("tenant_id", "id")',
    );
    expect(allSql).toContain(
      'CONSTRAINT "events_trigger_version_tenant_fk" FOREIGN KEY ("tenant_id", "trigger_id", "trigger_version") REFERENCES "trigger_versions"("tenant_id", "trigger_id", "version")',
    );
    expect(allSql).toContain(
      'CONSTRAINT "runs_workflow_tenant_fk" FOREIGN KEY ("tenant_id", "workflow_id") REFERENCES "workflows"("tenant_id", "id")',
    );
    expect(allSql).toContain(
      'CONSTRAINT "runs_project_tenant_fk"\n  FOREIGN KEY ("tenant_id", "project_id") REFERENCES "projects"("tenant_id", "id")',
    );
    expect(allSql).toContain(
      'CONSTRAINT "conversation_goal_states_conversation_tenant_fk" FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "conversations"("tenant_id", "id")',
    );
    expect(allSql).toContain(
      'CONSTRAINT "events_payload_or_reference_check" CHECK ("payload" IS NOT NULL OR "payload_reference" IS NOT NULL)',
    );
    expect(allSql).toContain(
      'CONSTRAINT "events_trigger_pair_check" CHECK (("trigger_id" IS NULL AND "trigger_version" IS NULL) OR ("trigger_id" IS NOT NULL AND "trigger_version" IS NOT NULL))',
    );
    expect(allSql).toContain(
      `CONSTRAINT "events_signature_status_check" CHECK ("signature_status" IN ('verified', 'unverified', 'failed'))`,
    );
    expect(allSql).toContain(
      'CONSTRAINT "workflow_versions_workflow_tenant_fk" FOREIGN KEY ("tenant_id", "workflow_id") REFERENCES "workflows"("tenant_id", "id")',
    );
    expect(allSql).toContain(
      'CONSTRAINT "workflow_versions_tenant_workflow_version_unique" UNIQUE ("tenant_id", "workflow_id", "version")',
    );
    const testGateMigration = migrationSql.find(
      ({ file }) => file === "0035_add_workflow_version_test_gate.sql",
    )?.sql;
    expect(testGateMigration).toContain(
      `CONSTRAINT workflow_versions_status_check CHECK ("status" IN ('compiled', 'tested', 'canary', 'promoted', 'rolled_back', 'retired'))`,
    );
    expect(testGateMigration).toContain(
      `CONSTRAINT workflow_versions_tested_evidence_check CHECK ("status" <> 'tested' OR (evaluation_run_id IS NOT NULL AND tested_at IS NOT NULL))`,
    );
    expect(allSql).toContain(
      'CONSTRAINT "blackboard_checkpoints_run_tenant_fk" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "runs"("tenant_id", "id") ON DELETE CASCADE',
    );
    expect(allSql).toContain(
      'CONSTRAINT "blackboard_checkpoints_tenant_run_key_pk" PRIMARY KEY ("tenant_id", "run_id", "context_key")',
    );
    expect(allSql).toContain(
      'CONSTRAINT "node_executions_run_tenant_fk" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "runs"("tenant_id", "id") ON DELETE CASCADE',
    );
    expect(allSql).toContain(
      `CONSTRAINT "node_executions_status_check" CHECK ("status" IN ('running', 'succeeded', 'failed', 'skipped', 'recovered'))`,
    );
    expect(allSql).toContain(
      'CONSTRAINT "runs_workflow_version_tenant_fk" FOREIGN KEY ("tenant_id", "workflow_version_id") REFERENCES "workflow_versions"("tenant_id", "id")',
    );
    expect(allSql).toContain(
      'CONSTRAINT "run_dispatch_queue_run_tenant_fk"\n    FOREIGN KEY ("tenant_id", "run_id") REFERENCES "runs"("tenant_id", "id")',
    );
    expect(allSql).toContain(
      'CONSTRAINT "verification_results_run_tenant_fk" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "runs"("tenant_id", "id") ON DELETE CASCADE',
    );
    expect(allSql).toContain(
      'CONSTRAINT "verification_results_node_execution_tenant_fk" FOREIGN KEY ("tenant_id", "node_execution_id") REFERENCES "node_executions"("tenant_id", "id") ON DELETE CASCADE',
    );
    expect(allSql).toContain(
      `CONSTRAINT "verification_results_gate_type_check" CHECK ("gate_type" IN ('quality', 'hallucination', 'safety', 'build', 'render', 'placeholder', 'security', 'acceptance'))`,
    );
    expect(allSql).toContain(
      `CONSTRAINT "verification_results_verdict_check" CHECK ("verdict" IN ('pass', 'fail', 'warn'))`,
    );
    expect(allSql).toContain(
      'CONSTRAINT "recovery_actions_run_tenant_fk" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "runs"("tenant_id", "id") ON DELETE CASCADE',
    );
    expect(allSql).toContain(
      `CONSTRAINT "recovery_actions_strategy_check" CHECK ("strategy" IS NULL OR "strategy" IN ('repair', 'retry', 'backoff', 'swap_agent', 'escalate_model', 'recompile', 'replan', 'degrade', 'ask_user', 'terminate'))`,
    );
    expect(allSql).toContain(
      'CREATE UNIQUE INDEX "idx_recovery_actions_pending_node"',
    );
    expect(allSql).toContain(
      'CONSTRAINT "run_outcomes_run_tenant_fk" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "runs"("tenant_id", "id") ON DELETE CASCADE',
    );
    expect(allSql).toContain(
      'CONSTRAINT "run_outcomes_tenant_run_unique" UNIQUE ("tenant_id", "run_id")',
    );
    expect(allSql).toContain(
      `CONSTRAINT "run_outcomes_verdict_check" CHECK ("verdict" IN ('completed_verified', 'rescued', 'escalated', 'failed', 'abandoned', 'degraded'))`,
    );
    expect(allSql).toContain(
      'CONSTRAINT "approvals_run_tenant_fk" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "runs"("tenant_id", "id") ON DELETE CASCADE',
    );
    expect(allSql).toContain(
      'CONSTRAINT "approvals_node_execution_tenant_fk" FOREIGN KEY ("tenant_id", "node_execution_id") REFERENCES "node_executions"("tenant_id", "id") ON DELETE CASCADE',
    );
    expect(allSql).toContain(
      `CONSTRAINT "approvals_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected', 'expired'))`,
    );
    expect(allSql).toContain(
      'CONSTRAINT "artifacts_run_tenant_fk" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "runs"("tenant_id", "id") ON DELETE CASCADE',
    );
    expect(allSql).toContain('CONSTRAINT "deployments_artifact_tenant_fk"');
    expect(allSql).toContain(
      'FOREIGN KEY ("tenant_id", "artifact_id")\n  REFERENCES "artifacts"("tenant_id", "id")',
    );
    expect(allSql).toContain('CONSTRAINT "deployments_status_check"');
    expect(allSql).toContain("'pending', 'active', 'failed', 'rolled_back', 'suspended'");
    expect(allSql).toContain('CREATE UNIQUE INDEX "idx_deployments_tenant_project_active"');
    expect(allSql).toContain(
      "cannot enforce one active deployment per project while duplicate active rows exist",
    );
    expect(allSql).toContain(
      `CONSTRAINT "workflow_template_variable_definitions_type_check" CHECK ("value_type" IN ('text', 'number', 'secret', 'list'))`,
    );
    expect(allSql).toContain(
      'CONSTRAINT "workflow_template_variable_definitions_version_tenant_fk" FOREIGN KEY ("tenant_id", "workflow_version_id") REFERENCES "workflow_versions"("tenant_id", "id") ON DELETE CASCADE',
    );
    expect(allSql).toContain(
      `CONSTRAINT "clarifications_status_check" CHECK ("status" IN ('open', 'answered', 'expired'))`,
    );
    expect(allSql).toContain(
      'CONSTRAINT "clarifications_conversation_tenant_fk" FOREIGN KEY ("tenant_id", "conversation_id") REFERENCES "conversations"("tenant_id", "id") ON DELETE CASCADE',
    );
  });

  it("local bootstrap creates isolated orchestration database ownership", () => {
    const script = readFileSync(
      resolve(process.cwd(), "infrastructure/local/engine-db-init.sh"),
      "utf8",
    );

    expect(script).toContain("CREATE ROLE orchestration_service LOGIN PASSWORD");
    expect(script).toContain("ALTER ROLE orchestration_service WITH LOGIN NOBYPASSRLS");
    expect(script).not.toContain("ALTER ROLE orchestration_service BYPASSRLS");
    expect(script).toContain(
      "CREATE DATABASE orchestration_db OWNER orchestration_service",
    );
    expect(script).toContain(
      "REVOKE CONNECT, TEMPORARY ON DATABASE orchestration_db FROM PUBLIC",
    );
    expect(script).toContain(
      "GRANT CONNECT, TEMPORARY ON DATABASE orchestration_db TO orchestration_service",
    );
  });
});
