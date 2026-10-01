import {
  check,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  sql,
  text,
  timestamp,
  unique,
  uuid,
} from "@alterx/adapters";
import { nodeExecutions } from "./node_executions";
import { runs } from "./runs";

/**
 * One Verification & Quality Gate check (doc 04 §3). Scoped to a run always,
 * optionally narrowed to one node_execution (a whole-run gate, e.g. final
 * acceptance, has node_execution_id NULL). Self-Healing phase (HEAL-1):
 * schema only -- no writer service yet.
 */
export const verificationResults = pgTable(
  "verification_results",
  {
    id: text("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    runId: text("run_id").notNull(),
    nodeExecutionId: text("node_execution_id"),
    gateType: text("gate_type").notNull(),
    verdict: text("verdict").notNull(),
    score: numeric("score"),
    threshold: numeric("threshold"),
    reviewerModel: text("reviewer_model"),
    details: jsonb("details"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "verification_results_gate_type_check",
      sql`${table.gateType} IN ('quality', 'hallucination', 'safety', 'build', 'render', 'placeholder', 'security', 'acceptance', 'mechanical')`,
    ),
    check(
      "verification_results_verdict_check",
      sql`${table.verdict} IN ('pass', 'fail', 'warn')`,
    ),
    unique("verification_results_tenant_id_id_unique").on(
      table.tenantId,
      table.id,
    ),
    foreignKey({
      name: "verification_results_run_tenant_fk",
      columns: [table.tenantId, table.runId],
      foreignColumns: [runs.tenantId, runs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "verification_results_node_execution_tenant_fk",
      columns: [table.tenantId, table.nodeExecutionId],
      foreignColumns: [nodeExecutions.tenantId, nodeExecutions.id],
    }).onDelete("cascade"),
    index("idx_verification_results_tenant_run_created").on(
      table.tenantId,
      table.runId,
      table.createdAt,
    ),
  ],
);
