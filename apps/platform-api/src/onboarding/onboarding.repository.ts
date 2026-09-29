import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { onboardingStepKeys } from "./step-config";
import type { OnboardingState, OnboardingStep } from "./types";

interface OnboardingRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  steps: OnboardingStep[];
  current_step: OnboardingState["currentStep"];
  status: OnboardingState["status"];
  created_at: Date;
  updated_at: Date;
}

export interface OnboardingInitializer {
  initialize(
    tenantId: string,
    workspaceId: string,
    transactionClient: PoolClient,
  ): Promise<OnboardingState>;
}

export const ONBOARDING_INITIALIZER = Symbol("ONBOARDING_INITIALIZER");

export class OnboardingRepository implements OnboardingInitializer {
  constructor(private readonly pool: Pool) {}

  async initialize(
    tenantId: string,
    workspaceId: string,
    transactionClient: PoolClient,
  ): Promise<OnboardingState> {
    const steps = initialSteps();
    const result = await transactionClient.query<OnboardingRow>(
      `INSERT INTO onboarding_states
        (id, tenant_id, workspace_id, steps, current_step, status)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'not_started')
       ON CONFLICT (workspace_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
       RETURNING *`,
      [randomUUID(), tenantId, workspaceId, JSON.stringify(steps), onboardingStepKeys[0]],
    );
    return mapRow(requiredRow(result.rows[0]));
  }

  find(tenantId: string, workspaceId: string): Promise<OnboardingState | null> {
    return this.withTenant(tenantId, async (client) => {
      const result = await client.query<OnboardingRow>(
        `SELECT * FROM onboarding_states
          WHERE tenant_id = $1 AND workspace_id = $2
          LIMIT 1`,
        [tenantId, workspaceId],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    });
  }

  save(
    state: OnboardingState,
    expectedUpdatedAt: Date,
  ): Promise<OnboardingState | null> {
    return this.withTenant(state.tenantId, async (client) => {
      const result = await client.query<OnboardingRow>(
        `UPDATE onboarding_states
            SET steps = $1::jsonb, current_step = $2, status = $3
          WHERE tenant_id = $4 AND workspace_id = $5
            -- expectedUpdatedAt is a JS Date (milliseconds); updated_at holds
            -- microseconds, so compare at the precision the caller has.
            AND date_trunc('milliseconds', updated_at) = $6
          RETURNING *`,
        [
          JSON.stringify(state.steps),
          state.currentStep,
          state.status,
          state.tenantId,
          state.workspaceId,
          expectedUpdatedAt,
        ],
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    });
  }

  private async withTenant<T>(
    tenantId: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [
        tenantId,
      ]);
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function initialSteps(): OnboardingStep[] {
  return onboardingStepKeys.map((stepKey) => ({
    stepKey,
    status: "pending",
    completedAt: null,
  }));
}

function requiredRow(row: OnboardingRow | undefined): OnboardingRow {
  if (!row) throw new Error("Onboarding write returned no row");
  return row;
}

function mapRow(row: OnboardingRow): OnboardingState {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    steps: row.steps,
    currentStep: row.current_step,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
