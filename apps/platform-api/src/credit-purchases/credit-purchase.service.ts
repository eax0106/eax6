import { Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { PoolClient } from "pg";
import { CreditCheckoutUrlSchema, CreditPurchaseIdSchema, CreateCreditPurchaseSchema, TenantIdSchema, type CreditPurchaseView } from "@alterx/contracts";
import { BillingOperationNotSubmittedError, type CreditPurchaseCheckout, type CreditPurchaseProvider,
  type CreditPurchaseProviderInput } from "@alterx/shared-clients";
import type { AuditEventsClient } from "../engine/audit-events-client";
import type { BillingPolicyService } from "../billing/billing-policy.service";
import { BillingWebhookRepository } from "../billing/billing-webhook.repository";
import { CreditPurchaseRepository, problem, quote, view, type CreditPurchaseAudit, type CreditPurchaseRow } from "./credit-purchase.repository";

const reconciler = { type: "service" as const, ref: "svc_billing-credit-purchases" };
type PurchaseActor = { type: "user" | "service"; ref: string };
const terminal = new Set(["delivered", "cancelled", "expired"]);

/**
 * @driver bootstrap Platform API bootstrap initializes CreditPurchaseModule;
 * Nest's module lifecycle starts and stops the durable reconciler.
 */
export class CreditPurchaseService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private draining = false;
  private readonly logger = new Logger(CreditPurchaseService.name);
  constructor(private readonly repository: CreditPurchaseRepository, private readonly provider: CreditPurchaseProvider,
    private readonly auditClient: Pick<AuditEventsClient, "record">, private readonly delivery: Pick<BillingPolicyService, "synchronize">,
    private readonly webhookRepository: Pick<BillingWebhookRepository, "enqueueCredits">) {}

  onModuleInit(): void {
    this.timer = setInterval(() => { void this.drain(); }, 10_000); this.timer.unref(); void this.drain();
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }

  async create(tenantId: string, userId: string, body: unknown, key: string | undefined): Promise<CreditPurchaseView> {
    const parsed = CreateCreditPurchaseSchema.safeParse(body);
    if (!parsed.success) throw problem(400, "INVALID_CREDIT_PURCHASE", "Use only a valid credit quantity, displayed plan version and optional GSTIN");
    const claim = await this.repository.claim(tenantId, userId, parsed.data, key ?? "", this.audit);
    if (claim.created) {
      try {
        const checkout = await deadline(this.provider.create(providerInput(claim.row)));
        await this.repository.transaction(tenantId, async tx => {
          const row = await this.repository.locked(tx, tenantId, claim.row.id);
          await this.applyCheckout(tx, row, checkout, undefined, { type: "user", ref: userId });
        });
      } catch (error) {
        if (error instanceof BillingOperationNotSubmittedError) {
          await this.repository.transaction(tenantId, async tx => {
            const row = await this.repository.locked(tx, tenantId, claim.row.id);
            if (row.state === "submitting" && !row.provider_ref) await this.transition(tx, row, { state: "cancelled" }, undefined, { type: "user", ref: userId });
          });
        }
        // The durable record is visible even after a rejected or uncertain
        // provider response. An uncertain POST is never submitted again.
        throw problem(502, "CREDIT_CHECKOUT_PENDING", "Checkout could not be confirmed; refresh purchase history before retrying");
      }
    }
    await this.deliverBestEffort(tenantId);
    return (await this.repository.read(tenantId, userId, claim.row.id))[0]!;
  }

  list(tenantId: string, userId: string) { return this.repository.read(tenantId, userId); }
  async get(tenantId: string, userId: string, id: string) { return (await this.repository.read(tenantId, userId, id))[0]!; }

  async refresh(tenantId: string, userId: string, id: string, ifMatch: string | undefined): Promise<CreditPurchaseView> {
    return this.reconcile(tenantId, id, { userId, ifMatch });
  }

  async reconcile(tenantId: string, id: string, caller?: { userId: string; ifMatch: string | undefined }, providerEventId?: string): Promise<CreditPurchaseView> {
    const reconciled = await this.repository.transaction(tenantId, async tx => {
      if (caller) await this.repository.authorize(tx, tenantId, caller.userId, true);
      const actor: PurchaseActor = caller ? { type: "user", ref: caller.userId } : reconciler;
      let row = await this.repository.locked(tx, tenantId, id);
      if (caller) {
        if (!caller.ifMatch) throw problem(428, "CREDIT_PURCHASE_REVISION_REQUIRED", "Displayed purchase revision is required");
        if (caller.ifMatch !== etag(view(row))) throw problem(412, "CREDIT_PURCHASE_CHANGED", "Purchase changed; refresh its current state");
      }
      if (terminal.has(row.state)) return row;
      const published = row.payment_ref ? await tx.query("SELECT published_at FROM billing_credit_deliveries WHERE tenant_id=$1 AND payment_ref=$2 AND published_at IS NOT NULL", [row.tenant_id, row.payment_ref]) : undefined;
      if (published?.rowCount) return this.transition(tx, row, { state: "delivered" }, providerEventId, actor);
      if (!row.payment_ref) {
        const input = providerInput(row);
        const checkout = await deadline(row.provider_ref ? this.provider.get(input, row.provider_ref) : this.provider.find(input));
        if (checkout) row = await this.applyCheckout(tx, row, checkout, providerEventId, actor);
      }
      await tx.query("UPDATE credit_purchases SET next_check_at=clock_timestamp()+interval '60 seconds' WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.id]);
      return row;
    });
    await this.deliverBestEffort(tenantId);
    return view(reconciled);
  }

  /** Only called by the dispatcher after raw webhook authentication. */
  async paidNotification(context: { tenantId: string; purchaseId: string }, providerEventId: string): Promise<void> {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(providerEventId)) throw problem(400, "CREDIT_EVENT_INVALID", "Provider event id is invalid");
    await this.reconcile(context.tenantId, context.purchaseId, undefined, providerEventId);
  }

  private readonly audit: CreditPurchaseAudit = async (row, from, actor) => {
    const ack = await deadline(this.auditClient.record({ tenant_id: `ten_${row.tenant_id}`, actor_type: actor.type,
      actor_ref: actor.ref, action: from === null ? "credit_purchase.created" : "credit_purchase.transitioned",
      target_type: "credit_purchase", target_ref: row.id, result: "success", reason_code: row.state,
      context_json: JSON.stringify({ scope: [row.id] }), occurred_at: new Date().toISOString() }));
    return ack.entry_hash;
  };

  private async applyCheckout(tx: PoolClient, row: CreditPurchaseRow, checkout: CreditPurchaseCheckout, providerEventId?: string, actor: PurchaseActor = reconciler): Promise<CreditPurchaseRow> {
    if (checkout.tenantId !== `ten_${row.tenant_id}` || checkout.referenceId !== row.id ||
        checkout.amountMinor !== row.total_minor || checkout.currency !== "INR" ||
        !/^plink_[A-Za-z0-9]{1,100}$/.test(checkout.id) || (row.provider_ref && row.provider_ref !== checkout.id)) {
      throw problem(502, "CREDIT_CHECKOUT_MISMATCH", "Provider checkout does not match its immutable purchase");
    }
    const url = CreditCheckoutUrlSchema.parse(checkout.checkoutUrl);
    if (row.payment_ref || terminal.has(row.state)) return row;
    let state: CreditPurchaseView["state"] = checkout.status === "created" ? "checkout_ready" :
      checkout.status === "cancelled" ? "cancelled" : checkout.status === "expired" ? "expired" : "payment_pending";
    let payment: string | undefined;
    if (checkout.status === "paid" && checkout.amountPaidMinor === row.total_minor && checkout.payments.length === 1) {
      const captured = checkout.payments[0]!, paidAt = Date.parse(captured.createdAt);
      if (captured.linkId !== checkout.id || captured.amountMinor !== row.total_minor || captured.status !== "captured" ||
          !/^pay_[A-Za-z0-9]{1,100}$/.test(captured.id) || !Number.isFinite(paidAt) ||
          paidAt < row.created_at.getTime() - 300_000 || paidAt > Date.now() + 300_000) {
        throw problem(502, "CREDIT_PAYMENT_MISMATCH", "Captured payment does not match the purchase");
      }
      payment = captured.id; state = "delivery_pending";
    }
    // A late create response cannot regress an already observed partial payment.
    if (row.state === "payment_pending" && state === "checkout_ready") state = "payment_pending";
    const changed = await this.transition(tx, row, { state, provider_ref: checkout.id, checkout_url: url,
      ...(payment ? { payment_ref: payment } : {}) }, providerEventId, actor);
    if (payment) await this.webhookRepository.enqueueCredits(tx, row.tenant_id, payment, row.credits, providerEventId ?? `credit-purchase:${row.id}`);
    return changed;
  }

  private async transition(tx: PoolClient, row: CreditPurchaseRow,
    change: { state: CreditPurchaseView["state"]; provider_ref?: string; checkout_url?: string; payment_ref?: string }, providerEventId?: string, actor: PurchaseActor = reconciler): Promise<CreditPurchaseRow> {
    if (change.state === row.state && (change.provider_ref === undefined || change.provider_ref === row.provider_ref) &&
        (change.payment_ref === undefined || change.payment_ref === row.payment_ref)) return row;
    const result = await tx.query<CreditPurchaseRow>(`UPDATE credit_purchases SET state=$3,provider_ref=COALESCE($4,provider_ref),
      checkout_url=COALESCE($5,checkout_url),payment_ref=COALESCE($6,payment_ref) WHERE tenant_id=$1 AND id=$2 RETURNING *`,
    [row.tenant_id, row.id, change.state, change.provider_ref ?? null, change.checkout_url ?? null, change.payment_ref ?? null]);
    const changed = result.rows[0]!;
    await this.repository.event(tx, changed, row.state, actor, this.audit, providerEventId);
    return changed;
  }

  private async deliverBestEffort(tenantId: string): Promise<void> {
    try { await this.delivery.synchronize(tenantId); } catch { /* The existing durable delivery remains pending. */ }
  }
  private async drain(): Promise<void> {
    if (this.draining) return; this.draining = true;
    try {
      const rows = await this.repository.due();
      for (let start = 0; start < rows.length; start += 4) {
        const results = await Promise.allSettled(rows.slice(start, start + 4).map(async row => {
          const tenant = `ten_${row.tenant_id}`;
          if (await this.repository.reserveDue(tenant, row.purchase_id)) await this.reconcile(tenant, row.purchase_id);
        }));
        if (results.some(result => result.status === "rejected")) this.logger.error("Credit purchase reconciliation remains pending");
      }
    } catch { this.logger.error("Credit purchase reconciliation inventory unavailable"); }
    finally { this.draining = false; }
  }
}

export function etag(purchase: CreditPurchaseView): string { return `"credit-purchase-${purchase.id}-${purchase.revision}"`; }
function providerInput(row: CreditPurchaseRow): CreditPurchaseProviderInput {
  return { tenantId: `ten_${row.tenant_id}`, purchaseId: row.id, quote: quote(row), gstin: row.gstin, expiresAt: row.expires_at.toISOString() };
}
export function creditPurchaseEventContext(payload: unknown): { tenantId: string; purchaseId: string } | null {
  const root = record(payload), nested = record(root["payload"]), link = record(record(nested["payment_link"])["entity"]), notes = record(link["notes"]);
  if (notes["alter_credit_purchase"] === undefined) return null;
  const tenant = TenantIdSchema.safeParse(notes["tenant_id"]), id = CreditPurchaseIdSchema.safeParse(notes["alter_credit_purchase"]);
  if (!tenant.success || !id.success || link["reference_id"] !== id.data) throw problem(400, "CREDIT_EVENT_INVALID", "Provider purchase reference is invalid");
  return { tenantId: tenant.data, purchaseId: id.data };
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** @driver create Customer checkout and reconciliation bound provider and audit confirmations. */
async function deadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(problem(503, "CREDIT_PURCHASE_DEADLINE", "Provider confirmation is unavailable; refresh the durable purchase")), 5_000); timer.unref();
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
