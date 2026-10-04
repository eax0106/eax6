import { randomUUID } from "node:crypto";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { PlanCommercialSchema, type PlanCommercial } from "./plan-commercial";
import type { Pool } from "pg";
import { ENTITLEMENT_LIMIT_KEYS, type EntitlementLimits } from "./types";

export const PLAN_DEFINITION_STORE = Symbol("PLAN_DEFINITION_STORE");

export type PlanDefinitionAuditAction = "created" | "updated" | "deleted";

export interface PlanDefinitionRecord {
  plan: string;
  limits: EntitlementLimits;
  commercial?: PlanCommercial | null;
  updatedAt: Date;
  updatedBy: string;
}

export interface PlanDefinitionAuditRecord {
  id: string;
  plan: string;
  action: PlanDefinitionAuditAction;
  limits: EntitlementLimits | null;
  commercial?: PlanCommercial | null;
  reason: string;
  staffUserId: string;
  occurredAt: Date;
}

/**
 * Read and write side of the global `plan_definitions` layer.
 *
 * Lives in `entitlements/` rather than `admin-policy/` on purpose: the
 * entitlement resolution path reads it (via PlanDefinitionConfigProvider)
 * and the staff admin plane writes it, so keeping it here makes the
 * dependency one-directional (admin-policy -> entitlements).
 */
export interface PlanDefinitionStore {
  list(): Promise<PlanDefinitionRecord[]>;
  find(plan: string): Promise<PlanDefinitionRecord | undefined>;
  upsert(
    plan: string,
    limits: EntitlementLimits,
    staffUserId: string,
    commercial?: PlanCommercial | null,
    auditReason?: string,
  ): Promise<{ record: PlanDefinitionRecord; created: boolean }>;
  remove(plan: string): Promise<boolean>;
  recordAudit(
    plan: string,
    action: PlanDefinitionAuditAction,
    limits: EntitlementLimits | null,
    reason: string,
    staffUserId: string,
    commercial?: PlanCommercial | null,
  ): Promise<void>;
  history(plan: string, limit: number): Promise<PlanDefinitionAuditRecord[]>;
}

interface PlanDefinitionRow {
  plan: string;
  limits: Record<string, number>;
  commercial?: unknown;
  updated_at: Date;
  updated_by: string;
}

interface PlanDefinitionAuditRow {
  id: string;
  plan: string;
  action: PlanDefinitionAuditAction;
  limits: Record<string, number> | null;
  commercial?: unknown;
  reason: string;
  staff_user_id: string;
  occurred_at: Date;
}

@Injectable()
export class PostgresPlanDefinitionStore
  implements PlanDefinitionStore, OnModuleDestroy
{
  constructor(
    private readonly pool: Pool,
    private readonly closePoolOnDestroy = false,
  ) {}

  async list(): Promise<PlanDefinitionRecord[]> {
    const result = await this.pool.query<PlanDefinitionRow>(
      `SELECT plan, limits, commercial, updated_at, updated_by
         FROM plan_definitions
        ORDER BY plan`,
    );
    return result.rows.map(mapRow);
  }

  async find(plan: string): Promise<PlanDefinitionRecord | undefined> {
    const result = await this.pool.query<PlanDefinitionRow>(
      `SELECT plan, limits, commercial, updated_at, updated_by
         FROM plan_definitions
        WHERE plan = $1`,
      [plan],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async upsert(
    plan: string,
    limits: EntitlementLimits,
    staffUserId: string,
    commercial?: PlanCommercial | null,
    auditReason?: string,
  ): Promise<{ record: PlanDefinitionRecord; created: boolean }> {
    const configured = commercial === undefined ? undefined : commercial === null ? null : PlanCommercialSchema.parse(commercial);
    const client = auditReason ? await this.pool.connect() : this.pool;
    try {
      if (auditReason) await client.query("BEGIN");
      const result = await client.query<PlanDefinitionRow & { created: boolean }>(
        `INSERT INTO plan_definitions (plan, limits, updated_by, commercial)
         VALUES ($1, $2::jsonb, $3, $4::jsonb)
         ON CONFLICT (plan) DO UPDATE
           SET limits = EXCLUDED.limits,
               commercial = CASE WHEN $5 THEN EXCLUDED.commercial ELSE plan_definitions.commercial END,
               updated_by = EXCLUDED.updated_by, updated_at = clock_timestamp()
         RETURNING plan, limits, commercial, updated_at, updated_by, (xmax = 0) AS created`,
        [plan, JSON.stringify(limits), staffUserId, configured ? JSON.stringify(configured) : null, commercial !== undefined],
      );
      const row = result.rows[0]!;
      const record = mapRow(row);
      if (auditReason) {
        await client.query(
          `INSERT INTO plan_definition_audit (id, plan, action, limits, reason, staff_user_id, commercial)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb)`,
          [`pda_${randomUUID()}`, plan, row.created ? "created" : "updated", JSON.stringify(limits), auditReason,
            staffUserId, record.commercial ? JSON.stringify(record.commercial) : null],
        );
        await client.query("COMMIT");
      }
      return { record, created: row.created };
    } catch (error) {
      if (auditReason) await client.query("ROLLBACK");
      throw error;
    } finally {
      if ("release" in client) client.release();
    }
  }

  async remove(plan: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM plan_definitions WHERE plan = $1`,
      [plan],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async recordAudit(
    plan: string,
    action: PlanDefinitionAuditAction,
    limits: EntitlementLimits | null,
    reason: string,
    staffUserId: string,
    commercial?: PlanCommercial | null,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO plan_definition_audit (id, plan, action, limits, reason, staff_user_id, commercial)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb)`,
      [
        `pda_${randomUUID()}`,
        plan,
        action,
        limits ? JSON.stringify(limits) : null,
        reason,
        staffUserId,
        commercial ? JSON.stringify(PlanCommercialSchema.parse(commercial)) : null,
      ],
    );
  }

  async history(plan: string, limit: number): Promise<PlanDefinitionAuditRecord[]> {
    const result = await this.pool.query<PlanDefinitionAuditRow>(
      `SELECT id, plan, action, limits, commercial, reason, staff_user_id, occurred_at
         FROM plan_definition_audit
        WHERE plan = $1
        ORDER BY occurred_at DESC
        LIMIT $2`,
      [plan, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      plan: row.plan,
      action: row.action,
      limits: row.limits ? toLimits(row.limits) : null,
      commercial: row.commercial == null ? null : PlanCommercialSchema.parse(row.commercial),
      reason: row.reason,
      staffUserId: row.staff_user_id,
      occurredAt: row.occurred_at,
    }));
  }

  async onModuleDestroy(): Promise<void> {
    if (this.closePoolOnDestroy) await this.pool.end();
  }
}

function mapRow(row: PlanDefinitionRow): PlanDefinitionRecord {
  return {
    plan: row.plan,
    limits: toLimits(row.limits),
    commercial: row.commercial == null ? null : PlanCommercialSchema.parse(row.commercial),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/**
 * The table's CHECK constraint already guarantees all seven keys are present
 * and non-negative integers, so this only narrows the jsonb shape back to
 * EntitlementLimits without re-validating.
 */
function toLimits(value: Record<string, number>): EntitlementLimits {
  return Object.fromEntries(
    ENTITLEMENT_LIMIT_KEYS.map((key) => [key, Number(value[key])]),
  ) as unknown as EntitlementLimits;
}
