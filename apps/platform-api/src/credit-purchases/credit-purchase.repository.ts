import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import type { Pool, PoolClient } from "pg";
import { CreditPurchaseIdSchema, CreditPurchaseQuoteSchema, CreditPurchaseViewSchema, TenantIdSchema,
  UserIdSchema, creditPurchaseAmounts, type CreateCreditPurchase, type CreditPurchaseView } from "@alterx/contracts";
import { PlanCommercialSchema } from "../entitlements/plan-commercial";
import { BillingHttpError } from "../billing/problem";

export const CREDIT_PURCHASE_INSTANCE = "/api/v1/billing/credit-purchases";
export interface CreditPurchaseRow {
  id: string; tenant_id: string; actor_ref: string; request_key: string; request_fingerprint: string;
  plan_id: string; plan_version: Date; credits: number; unit_price_minor: number; credits_per_verified_run: number;
  base_price_minor: number; gst_minor: number; total_minor: number; gstin: string | null; expires_at: Date;
  state: CreditPurchaseView["state"]; provider_ref: string | null; checkout_url: string | null; payment_ref: string | null;
  revision: number; next_check_at: Date; created_at: Date; updated_at: Date;
}
export type CreditPurchaseAudit = (row: CreditPurchaseRow, from: string | null, actor: { type: "user" | "service"; ref: string }) => Promise<string>;

export class CreditPurchaseRepository {
  constructor(private readonly pool: Pool) {}

  async transaction<T>(tenantId: string, operation: (tx: PoolClient) => Promise<T>): Promise<T> {
    const tenant = TenantIdSchema.parse(tenantId).slice(4), tx = await this.pool.connect();
    try {
      await tx.query("BEGIN"); await tx.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenant]);
      const subject = await tx.query("SELECT id FROM tenants WHERE id=$1 AND status='active' AND deleted_at IS NULL FOR SHARE", [tenant]);
      if (!subject.rowCount) throw problem(404, "CREDIT_PURCHASE_TENANT_UNAVAILABLE", "Tenant is unavailable");
      const result = await operation(tx); await tx.query("COMMIT"); return result;
    } catch (error) { await tx.query("ROLLBACK"); throw error; } finally { tx.release(); }
  }

  async authorize(tx: PoolClient, tenantId: string, userId: string, write: boolean): Promise<void> {
    const user = UserIdSchema.parse(userId).slice(4);
    const member = await tx.query(`SELECT m.user_id FROM tenant_members m JOIN users u ON u.id=m.user_id
      WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.role=ANY($3::text[]) AND u.status='active' FOR SHARE OF m,u`,
    [TenantIdSchema.parse(tenantId).slice(4), user, write ? ["owner"] : ["owner", "admin"]]);
    if (!member.rowCount) throw problem(403, "CREDIT_PURCHASE_FORBIDDEN", "Current tenant billing authorization is required");
  }

  async claim(tenantId: string, userId: string, input: CreateCreditPurchase, key: string, audit: CreditPurchaseAudit) {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw problem(400, "CREDIT_PURCHASE_KEY_REQUIRED", "A valid Idempotency-Key is required");
    const fingerprint = createHash("sha256").update(JSON.stringify({ userId, ...input })).digest("hex");
    return this.transaction(tenantId, async tx => {
      await this.authorize(tx, tenantId, userId, true);
      const tenant = tenantId.slice(4);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`credit-purchase:${tenant}`]);
      const existing = await tx.query<CreditPurchaseRow>("SELECT * FROM credit_purchases WHERE tenant_id=$1 AND request_key=$2 FOR UPDATE", [tenant, key]);
      if (existing.rows[0]) {
        if (existing.rows[0].request_fingerprint !== fingerprint) throw problem(409, "CREDIT_PURCHASE_KEY_CONFLICT", "Request key already identifies a different purchase");
        return { row: existing.rows[0], created: false };
      }
      const pending = await tx.query("SELECT id FROM credit_purchases WHERE tenant_id=$1 AND state IN ('submitting','checkout_ready','payment_pending','delivery_pending') LIMIT 1", [tenant]);
      if (pending.rowCount) throw problem(409, "CREDIT_PURCHASE_PENDING", "Refresh the existing pending purchase before starting another");
      const profile = await tx.query<{ current_plan: string }>("SELECT current_plan FROM billing_profiles WHERE tenant_id=$1 FOR SHARE", [tenant]);
      const plan = profile.rows[0]?.current_plan;
      if (!plan || plan === "free") throw problem(503, "CREDIT_PURCHASE_UNCONFIGURED", "Extra-credit checkout requires a configured paid plan");
      const entitlement = await tx.query<{ plan: string }>(`SELECT plan FROM entitlements WHERE tenant_id=$1
        AND (effective_from IS NULL OR effective_from<=clock_timestamp()) AND (effective_to IS NULL OR effective_to>clock_timestamp())
        ORDER BY effective_from DESC NULLS LAST,created_at DESC LIMIT 1 FOR SHARE`, [tenant]);
      if (entitlement.rows[0]?.plan !== plan) throw problem(503, "CREDIT_PURCHASE_UNCONFIGURED", "Extra-credit checkout requires the current effective paid plan");
      const definition = await tx.query<{ commercial: unknown; updated_at: Date }>("SELECT commercial,updated_at FROM plan_definitions WHERE plan=$1 FOR SHARE", [plan]);
      const row = definition.rows[0], commercial = PlanCommercialSchema.safeParse(row?.commercial);
      if (!row || !commercial.success || !commercial.data.extraCreditPriceMinor || !commercial.data.creditsPerVerifiedRun) {
        throw problem(503, "CREDIT_PURCHASE_UNCONFIGURED", "Extra-credit pricing is unavailable until launch configuration is set");
      }
      if (row.updated_at.toISOString() !== input.plan_version) throw problem(412, "CREDIT_PURCHASE_PLAN_CHANGED", "Plan price changed; review the current configuration before checkout");
      let amounts: ReturnType<typeof creditPurchaseAmounts>;
      try { amounts = creditPurchaseAmounts(input.credits, commercial.data.extraCreditPriceMinor); }
      catch { throw problem(400, "CREDIT_PURCHASE_AMOUNT_INVALID", "Credit checkout total must be between ₹1 and ₹10000000"); }
      const created = await tx.query<CreditPurchaseRow>(`INSERT INTO credit_purchases
        (id,tenant_id,actor_ref,request_key,request_fingerprint,plan_id,plan_version,credits,unit_price_minor,
         credits_per_verified_run,base_price_minor,gst_minor,total_minor,gstin,expires_at,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,clock_timestamp()+interval '72 hours','submitting') RETURNING *`,
      [`cpx_${uuidv7()}`, tenant, userId, key, fingerprint, plan, input.plan_version, input.credits,
        commercial.data.extraCreditPriceMinor, commercial.data.creditsPerVerifiedRun, amounts.basePriceMinor,
        amounts.gstMinor, amounts.totalMinor, input.gstin ?? null]);
      const purchase = created.rows[0]!;
      await this.event(tx, purchase, null, { type: "user", ref: userId }, audit);
      return { row: purchase, created: true };
    });
  }

  async locked(tx: PoolClient, tenantId: string, purchaseId: string): Promise<CreditPurchaseRow> {
    CreditPurchaseIdSchema.parse(purchaseId);
    const result = await tx.query<CreditPurchaseRow>("SELECT * FROM credit_purchases WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId.slice(4), purchaseId]);
    if (!result.rows[0]) throw problem(404, "CREDIT_PURCHASE_NOT_FOUND", "Credit purchase not found");
    return result.rows[0];
  }

  async event(tx: PoolClient, row: CreditPurchaseRow, from: string | null,
    actor: { type: "user" | "service"; ref: string }, audit: CreditPurchaseAudit, providerEventId?: string): Promise<void> {
    const hash = await audit(row, from, actor);
    if (!/^[a-f0-9]{64}$/i.test(hash)) throw problem(502, "CREDIT_PURCHASE_AUDIT_UNAVAILABLE", "Credit purchase audit was not acknowledged");
    await tx.query(`INSERT INTO credit_purchase_events(id,tenant_id,purchase_id,actor_type,actor_ref,from_state,to_state,revision,audit_hash,provider_event_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [`cpe_${uuidv7()}`, row.tenant_id, row.id, actor.type, actor.ref,
      from, row.state, row.revision, hash, providerEventId ?? null]);
  }

  async read(tenantId: string, userId: string, purchaseId?: string): Promise<CreditPurchaseView[]> {
    if (purchaseId !== undefined) CreditPurchaseIdSchema.parse(purchaseId);
    return this.transaction(tenantId, async tx => {
      await this.authorize(tx, tenantId, userId, false);
      const result = await tx.query<CreditPurchaseRow>(`SELECT * FROM credit_purchases WHERE tenant_id=$1
        AND ($2::text IS NULL OR id=$2) ORDER BY created_at DESC,id DESC LIMIT 50`, [tenantId.slice(4), purchaseId ?? null]);
      if (purchaseId && !result.rows[0]) throw problem(404, "CREDIT_PURCHASE_NOT_FOUND", "Credit purchase not found");
      return result.rows.map(view);
    });
  }

  async reserveDue(tenantId: string, purchaseId: string): Promise<boolean> {
    return this.transaction(tenantId, async tx => {
      const row = await this.locked(tx, tenantId, purchaseId);
      if (!["submitting", "checkout_ready", "payment_pending", "delivery_pending"].includes(row.state) || row.next_check_at.getTime() > Date.now()) return false;
      // Persist backoff before external reads. Failed provider calls cannot
      // monopolize the oldest inventory entries or cause repeated hot polling.
      await tx.query("UPDATE credit_purchases SET next_check_at=clock_timestamp()+interval '60 seconds' WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.id]);
      return true;
    });
  }

  async due(): Promise<{ tenant_id: string; purchase_id: string }[]> {
    return (await this.pool.query<{ tenant_id: string; purchase_id: string }>("SELECT * FROM list_due_credit_purchases(100)")).rows;
  }
}

export function view(row: CreditPurchaseRow): CreditPurchaseView {
  return CreditPurchaseViewSchema.parse({ id: row.id, quote: quote(row), gstin: row.gstin, state: row.state,
    checkoutUrl: row.checkout_url, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), revision: row.revision });
}
export function quote(row: CreditPurchaseRow) {
  return CreditPurchaseQuoteSchema.parse({ planId: row.plan_id, planVersion: row.plan_version.toISOString(), credits: row.credits,
    unitPriceMinor: row.unit_price_minor, creditsPerVerifiedRun: row.credits_per_verified_run, basePriceMinor: row.base_price_minor,
    gstPercent: 18, gstMinor: row.gst_minor, totalMinor: row.total_minor, currency: "INR", gatewayFeeMinor: 0 });
}
export function problem(status: 400 | 403 | 404 | 409 | 412 | 428 | 502 | 503, code: string, detail: string): BillingHttpError {
  return new BillingHttpError(status, code, detail, CREDIT_PURCHASE_INSTANCE);
}
