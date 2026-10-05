import { createHash } from "node:crypto";
import { RunIdSchema, TenantIdSchema } from "@alterx/contracts";
import { z } from "zod";
import type { OrchestrationTenantStore, OrchestrationTransactionLike } from "../runs/run-launcher.service";

export const BillingAccountPolicySchema = z.object({
  tenantId: TenantIdSchema, plan: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/),
  revision: z.string().datetime(), accessState: z.enum(["active","grace","limited","suspended"]),
  emailVerified: z.boolean(), free: z.boolean(), maxRunsPerDay: z.number().int().min(0).max(1_000_000_000),
  creditsPerVerifiedRun: z.number().int().positive().max(1_000_000_000).nullable(),
}).strict();
export type BillingAccountPolicy = z.infer<typeof BillingAccountPolicySchema>;

export class BillingAdmissionError extends Error {
  constructor(readonly code: string) { super(code); this.name="BillingAdmissionError"; }
}
interface AccountRow extends Record<string, unknown> {
  source_revision: Date; policy_hash: string; access_state: string; email_verified: boolean; is_free: boolean;
  max_runs_per_day: number; credits_per_verified_run: number | null;
  credit_balance: string; reserved_credits: string;
}

/** Admission and verified settlement share the engine's existing tenant transaction. */
export class EngineBillingAccountService {
  constructor(private readonly store: OrchestrationTenantStore) {}

  async readAccount(tenantIdInput: string) {
    const tenantId = TenantIdSchema.parse(tenantIdInput).slice(4);
    return this.store.withTenant(tenantId, async tx => {
      await this.lockAccount(tx, tenantId);
      await this.reconcileTerminalReservations(tx, tenantId);
      const row = await this.lockAccount(tx, tenantId);
      return { balance: row.credit_balance, reserved: row.reserved_credits,
        available: (BigInt(row.credit_balance) - BigInt(row.reserved_credits)).toString() };
    });
  }

  async syncPolicy(input: unknown): Promise<void> {
    const policy = BillingAccountPolicySchema.parse(input), tenantId = policy.tenantId.slice(4);
    const hash = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
    await this.store.withTenant(tenantId,async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`billing-account:${tenantId}`]);
      const existing = await tx.query<AccountRow>("SELECT * FROM billing_accounts WHERE tenant_id=$1 FOR UPDATE",[tenantId]);
      const current = existing.rows[0], revision = new Date(policy.revision);
      if (current && new Date(current.source_revision).getTime() > revision.getTime()) return;
      if (current && new Date(current.source_revision).getTime() === revision.getTime()) {
        if (current.policy_hash !== hash) throw new BillingAdmissionError("BILLING_POLICY_REVISION_CONFLICT");
        return;
      }
      await tx.query(`INSERT INTO billing_accounts (tenant_id,plan,source_revision,policy_hash,access_state,email_verified,
          is_free,max_runs_per_day,credits_per_verified_run)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (tenant_id) DO UPDATE SET plan=$2,source_revision=$3,policy_hash=$4,access_state=$5,email_verified=$6,
          is_free=$7,max_runs_per_day=$8,credits_per_verified_run=$9,updated_at=clock_timestamp()`,
        [tenantId,policy.plan,revision,hash,policy.accessState,policy.emailVerified,policy.free,policy.maxRunsPerDay,policy.creditsPerVerifiedRun]);
    });
  }

  async grant(tenantIdInput: string, eventRef: string, credits: number): Promise<boolean> {
    const tenantId = TenantIdSchema.parse(tenantIdInput).slice(4);
    z.string().min(1).max(255).parse(eventRef); z.number().int().positive().max(1_000_000_000).parse(credits);
    return this.store.withTenant(tenantId,async tx => {
      await this.lockAccount(tx,tenantId);
      const inserted = await tx.query(`INSERT INTO billing_credit_grants (tenant_id,event_ref,credits) VALUES ($1,$2,$3)
        ON CONFLICT (tenant_id,event_ref) DO NOTHING RETURNING credits`,[tenantId,eventRef,credits]);
      if (!inserted.rowCount) {
        const existing = await tx.query<{ credits: number }>("SELECT credits FROM billing_credit_grants WHERE tenant_id=$1 AND event_ref=$2",[tenantId,eventRef]);
        if (existing.rows[0]?.credits !== credits) throw new BillingAdmissionError("BILLING_GRANT_CONFLICT");
        return false;
      }
      await tx.query("UPDATE billing_accounts SET credit_balance=credit_balance+$2,updated_at=clock_timestamp() WHERE tenant_id=$1",[tenantId,credits]);
      return true;
    });
  }

  async reserve(tx: OrchestrationTransactionLike, input: { tenantId: string; runId: string }): Promise<void> {
    const tenantId = TenantIdSchema.parse(input.tenantId.startsWith("ten_") ? input.tenantId : `ten_${input.tenantId}`).slice(4);
    RunIdSchema.parse(input.runId);
    await this.lockAccount(tx,tenantId);
    await this.reconcileTerminalReservations(tx,tenantId);
    const account = await this.lockAccount(tx,tenantId);
    if (!account.email_verified) throw new BillingAdmissionError("EMAIL_VERIFICATION_REQUIRED");
    if (account.access_state === "suspended") throw new BillingAdmissionError("BILLING_ACCOUNT_SUSPENDED");
    const previous = await tx.query("SELECT 1 FROM billing_run_reservations WHERE tenant_id=$1 AND run_id=$2",[tenantId,input.runId]);
    if (previous.rowCount) return;
    // The just-inserted run participates in this count; a refusal rolls it back.
    const usage = await tx.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM runs WHERE tenant_id=$1
      AND created_at >= date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,[tenantId]);
    if (Number(usage.rows[0]?.count ?? 0) > account.max_runs_per_day) throw new BillingAdmissionError("DAILY_RUN_LIMIT_REACHED");
    if (!account.is_free && account.credits_per_verified_run === null) throw new BillingAdmissionError("BILLING_PRICE_UNCONFIGURED");
    const credits = account.is_free ? 0 : account.credits_per_verified_run ?? 0;
    if (BigInt(account.credit_balance)-BigInt(account.reserved_credits) < BigInt(credits)) throw new BillingAdmissionError("INSUFFICIENT_RUN_CREDITS");
    await tx.query("UPDATE billing_accounts SET reserved_credits=reserved_credits+$2 WHERE tenant_id=$1",[tenantId,credits]);
    await tx.query("INSERT INTO billing_run_reservations (tenant_id,run_id,credits) VALUES ($1,$2,$3)",[tenantId,input.runId,credits]);
  }

  async settle(tenantIdInput: string, runId: string): Promise<void> {
    const tenantId=TenantIdSchema.parse(tenantIdInput.startsWith("ten_") ? tenantIdInput : `ten_${tenantIdInput}`).slice(4);
    RunIdSchema.parse(runId);
    await this.store.withTenant(tenantId, tx => this.settleTransaction(tx, tenantId, runId));
  }

  async settleTransaction(tx: OrchestrationTransactionLike, tenantId: string, runId: string): Promise<void> {
    return settleRunBillingTransaction(tx, tenantId, runId);
  }

  private async reconcileTerminalReservations(tx: OrchestrationTransactionLike, tenantId: string): Promise<void> {
    const candidates = await tx.query<{ run_id: string }>(`SELECT held.run_id FROM billing_run_reservations held
      JOIN runs r ON r.tenant_id = held.tenant_id AND r.id = held.run_id
      JOIN run_outcomes o ON o.tenant_id = r.tenant_id AND o.run_id = r.id
      WHERE held.tenant_id = $1 AND held.state = 'reserved' AND r.status IN ('completed','failed','cancelled')
      ORDER BY r.ended_at NULLS LAST, held.run_id LIMIT 25`, [tenantId]);
    for (const row of candidates.rows) await this.settleTransaction(tx, tenantId, row.run_id);
  }

  private async lockAccount(tx: OrchestrationTransactionLike,tenantId: string): Promise<AccountRow> {
    return lockBillingAccount(tx, tenantId);
  }
}

async function lockBillingAccount(tx: OrchestrationTransactionLike, tenantId: string): Promise<AccountRow> {
    const result=await tx.query<AccountRow>("SELECT *,credit_balance::text,reserved_credits::text FROM billing_accounts WHERE tenant_id=$1 FOR UPDATE",[tenantId]);
    if (!result.rows[0]) throw new BillingAdmissionError("BILLING_POLICY_UNAVAILABLE");
    return result.rows[0];
}

/** Settle against preserved outcome and acceptance evidence before erasing run history. */
export async function settleRunBillingTransaction(tx: OrchestrationTransactionLike, tenantId: string, runId: string): Promise<void> {
      const exists = await tx.query("SELECT 1 FROM billing_run_reservations WHERE tenant_id=$1 AND run_id=$2", [tenantId,runId]);
      if (!exists.rowCount) return;
      await lockBillingAccount(tx,tenantId);
      const reservation=await tx.query<{ credits: number; state: string }>("SELECT credits,state FROM billing_run_reservations WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE",[tenantId,runId]);
      const held=reservation.rows[0]; if (!held || held.state!=="reserved") return;
      const result=await tx.query<{ status: string; verified: boolean; outcome_recorded: boolean }>(`SELECT r.status, o.run_id IS NOT NULL AS outcome_recorded,
        (o.verdict IN ('completed_verified','rescued') AND NOT o.critical_external_error AND
         (SELECT v.verdict='pass' FROM verification_results v WHERE v.tenant_id=r.tenant_id AND v.run_id=r.id
            AND v.node_execution_id IS NULL AND v.gate_type='acceptance' ORDER BY v.created_at DESC,v.id DESC LIMIT 1)) AS verified
        FROM runs r LEFT JOIN run_outcomes o ON o.tenant_id=r.tenant_id AND o.run_id=r.id
        WHERE r.tenant_id=$1 AND r.id=$2`,[tenantId,runId]);
      const run=result.rows[0]; if (!run || !["completed","failed","cancelled"].includes(run.status)) return;
      if (run.status === "completed" && !run.outcome_recorded) return;
      const charged=run.status==="completed" && run.verified===true;
      await tx.query("UPDATE billing_accounts SET reserved_credits=reserved_credits-$2,credit_balance=credit_balance-$3,updated_at=clock_timestamp() WHERE tenant_id=$1",[tenantId,held.credits,charged ? held.credits : 0]);
      await tx.query("UPDATE billing_run_reservations SET state=$3,settled_at=clock_timestamp() WHERE tenant_id=$1 AND run_id=$2",[tenantId,runId,charged ? "charged" : "released"]);
}

/** Release unfinished holds while keeping previously charged credits spent. */
export async function eraseRunBillingReservations(tx: OrchestrationTransactionLike, tenantId: string, runIds: readonly string[]): Promise<number> {
  if (runIds.length === 0) return 0;
  const account = await tx.query("SELECT 1 FROM billing_accounts WHERE tenant_id=$1 FOR UPDATE", [tenantId]);
  if (!account.rowCount) return 0;
  const held = await tx.query<{ run_id: string }>("SELECT run_id FROM billing_run_reservations WHERE tenant_id=$1 AND run_id=ANY($2::text[]) AND state='reserved' ORDER BY run_id", [tenantId, runIds]);
  for (const row of held.rows) await settleRunBillingTransaction(tx, tenantId, row.run_id);
  const removed = await tx.query<{ credits: number; state: string }>("DELETE FROM billing_run_reservations WHERE tenant_id=$1 AND run_id=ANY($2::text[]) RETURNING credits,state", [tenantId, runIds]);
  const released = removed.rows.reduce((sum, row) => sum + (row.state === "reserved" ? BigInt(row.credits) : 0n), 0n);
  if (released > 0n) await tx.query("UPDATE billing_accounts SET reserved_credits=reserved_credits-$2,updated_at=clock_timestamp() WHERE tenant_id=$1", [tenantId, released.toString()]);
  return removed.rowCount;
}
