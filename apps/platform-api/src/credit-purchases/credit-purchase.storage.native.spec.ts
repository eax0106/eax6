import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CreditPurchaseCheckout } from "@alterx/shared-clients";
import { etag } from "./credit-purchase.service";
import { createCreditPurchaseNativeDriver, type CreditPurchaseNativeDriver } from "./testing/credit-purchase-native-driver";

const databaseUrl = process.env.DATABASE_URL ?? "";
const key = () => randomUUID().replaceAll("-", "");

describe.skipIf(!databaseUrl)("credit purchases ordinary PostgreSQL", () => {
  let d: CreditPurchaseNativeDriver;
  beforeEach(async () => { d = await createCreditPurchaseNativeDriver(databaseUrl); });
  afterEach(async () => { await d?.close(); });
  const create = () => d.service.create(d.tenant, d.user, d.input, key());
  async function paid() {
    const purchase = await create();
    d.checkout = { ...d.checkout!, status: "paid", amountPaidMinor: purchase.quote.totalMinor,
      payments: [{ id: "pay_purchaseNative", linkId: d.checkout!.id, amountMinor: purchase.quote.totalMinor, status: "captured", createdAt: new Date().toISOString() }] };
    return purchase;
  }
  const deliveries = async () => (await d.admin.query("SELECT * FROM billing_credit_deliveries")).rows;

  it("uses a non-owner role held to FORCE RLS and snapshots exact integer price/GST plus the real actor", async () => {
    const roles = await d.pool.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
    expect(roles.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const purchase = await create();
    expect(purchase).toMatchObject({ state: "checkout_ready", revision: 2, gstin: d.input.gstin, quote: { credits: 3, unitPriceMinor: 50, basePriceMinor: 150, gstMinor: 27, totalMinor: 177, gatewayFeeMinor: 0 } });
    expect(d.audits[0]).toMatchObject({ actor_type: "user", actor_ref: d.user, tenant_id: d.tenant });
    expect((await d.admin.query("SELECT actor_ref,request_fingerprint FROM credit_purchases")).rows[0]).toMatchObject({ actor_ref: d.user, request_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const tables = await d.admin.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace=$1::regnamespace AND relname=ANY($2::text[])", [d.schema, ["credit_purchases", "credit_purchase_events"]]);
    expect(tables.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }, { relrowsecurity: true, relforcerowsecurity: true }]);
    expect((await d.pool.query("SELECT * FROM credit_purchases")).rows).toEqual([]);
    expect(await deliveries()).toEqual([]);
  });

  it("serializes concurrent identical retries and refuses changed quantities with the same key", async () => {
    const requestKey = key();
    const results = await Promise.all([d.service.create(d.tenant, d.user, d.input, requestKey), d.service.create(d.tenant, d.user, d.input, requestKey)]);
    expect(results[0]!.id).toBe(results[1]!.id); expect(d.creates).toBe(1);
    await expect(d.service.create(d.tenant, d.user, { ...d.input, credits: 4 }, requestKey)).rejects.toMatchObject({ response: { error_code: "CREDIT_PURCHASE_KEY_CONFLICT" } });
    await expect(create()).rejects.toMatchObject({ response: { error_code: "CREDIT_PURCHASE_PENDING" } });
    expect((await d.admin.query("SELECT * FROM credit_purchases")).rows).toHaveLength(1);
  });

  it("recovers a provider-committed lost response with the same durable reference and no second POST", async () => {
    d.failCreate = true; const requestKey = key();
    await expect(d.service.create(d.tenant, d.user, d.input, requestKey)).rejects.toMatchObject({ response: { error_code: "CREDIT_CHECKOUT_PENDING" } });
    const pending = await d.service.create(d.tenant, d.user, d.input, requestKey);
    expect(pending.state).toBe("submitting"); expect(d.creates).toBe(1);
    const recovered = await d.service.refresh(d.tenant, d.user, pending.id, etag(pending));
    expect(recovered).toMatchObject({ id: pending.id, state: "checkout_ready" }); expect(d.creates).toBe(1);
    expect(d.providerInputs[0]!.purchaseId).toBe(pending.id); expect(await deliveries()).toEqual([]);
  });

  it("rolls back creation or payment delivery when central audit fails or its acknowledgement is malformed", async () => {
    d.auditHash = "bad";
    await expect(create()).rejects.toMatchObject({ response: { error_code: "CREDIT_PURCHASE_AUDIT_UNAVAILABLE" } });
    expect(d.creates).toBe(0); expect((await d.admin.query("SELECT * FROM credit_purchases")).rows).toEqual([]);
    d.auditHash = "a".repeat(64); const purchase = await paid(); d.failAudit = true;
    await expect(d.service.refresh(d.tenant, d.user, purchase.id, etag(purchase))).rejects.toThrow("Audit unavailable");
    expect((await d.service.get(d.tenant, d.user, purchase.id)).state).toBe("checkout_ready"); expect(await deliveries()).toEqual([]);
  });

  it("requires current active owner, current paid entitlement and displayed locked configuration", async () => {
    await d.admin.query("UPDATE users SET status='suspended' WHERE id=$1", [d.userA]);
    await expect(create()).rejects.toMatchObject({ response: { error_code: "CREDIT_PURCHASE_FORBIDDEN" } });
    await d.admin.query("UPDATE users SET status='active' WHERE id=$1;", [d.userA]);
    await d.admin.query("UPDATE tenant_members SET role='admin' WHERE tenant_id=$1", [d.tenantA]);
    await expect(create()).rejects.toMatchObject({ response: { error_code: "CREDIT_PURCHASE_FORBIDDEN" } });
    await d.admin.query("UPDATE tenant_members SET role='owner' WHERE tenant_id=$1", [d.tenantA]);
    await d.admin.query("UPDATE entitlements SET plan='free' WHERE tenant_id=$1", [d.tenantA]);
    await expect(create()).rejects.toMatchObject({ response: { error_code: "CREDIT_PURCHASE_UNCONFIGURED" } });
    await d.admin.query("UPDATE entitlements SET plan='basic' WHERE tenant_id=$1", [d.tenantA]);
    await d.admin.query("UPDATE plan_definitions SET updated_at=updated_at+interval '1 second' WHERE plan='basic'");
    await expect(create()).rejects.toMatchObject({ response: { error_code: "CREDIT_PURCHASE_PLAN_CHANGED" } }); expect(d.creates).toBe(0);
  });

  it("rejects foreign subjects, missing/stale revisions and strict client-controlled financial fields", async () => {
    await expect(d.service.create(d.tenant, d.user, { ...d.input, totalMinor: 1 }, key())).rejects.toMatchObject({ response: { error_code: "INVALID_CREDIT_PURCHASE" } });
    const purchase = await create();
    await expect(d.service.get(d.otherTenant, d.otherUser, purchase.id)).rejects.toMatchObject({ response: { error_code: "CREDIT_PURCHASE_NOT_FOUND" } });
    await expect(d.service.refresh(d.tenant, d.user, purchase.id, undefined)).rejects.toMatchObject({ response: { error_code: "CREDIT_PURCHASE_REVISION_REQUIRED" } });
    await expect(d.service.refresh(d.tenant, d.user, purchase.id, '"stale"')).rejects.toMatchObject({ response: { error_code: "CREDIT_PURCHASE_CHANGED" } }); expect(d.reads).toBe(0);
  });

  it("never grants unpaid, partial or receipt-less checkout and retains immutable pending quantities", async () => {
    const purchase = await create();
    d.checkout = { ...d.checkout!, status: "partially_paid", amountPaidMinor: 50 };
    const partial = await d.service.refresh(d.tenant, d.user, purchase.id, etag(purchase)); expect(partial.state).toBe("payment_pending");
    d.checkout = { ...d.checkout!, status: "paid", amountPaidMinor: purchase.quote.totalMinor, payments: [] };
    expect((await d.service.refresh(d.tenant, d.user, purchase.id, etag(partial))).state).toBe("payment_pending");
    d.checkout = { ...d.checkout!, payments: [0,1].map(index => ({ id: `pay_duplicate${index}`, linkId: d.checkout!.id,
      amountMinor: purchase.quote.totalMinor, status: "captured", createdAt: new Date().toISOString() })) };
    expect((await d.service.refresh(d.tenant, d.user, purchase.id, etag(partial))).state).toBe("payment_pending");
    expect(await deliveries()).toEqual([]);
    await expect(d.repository.transaction(d.tenant, tx => tx.query("UPDATE credit_purchases SET credits=4 WHERE id=$1", [purchase.id]))).rejects.toThrow("immutable");
    expect((await d.repository.transaction(d.tenant, tx => tx.query("UPDATE credit_purchase_events SET actor_ref='made-up' WHERE purchase_id=$1", [purchase.id]))).rowCount).toBe(0);
    await expect(d.admin.query("UPDATE credit_purchase_events SET actor_ref='made-up' WHERE purchase_id=$1", [purchase.id])).rejects.toThrow("append-only");
    expect((await d.admin.query("SELECT actor_ref FROM credit_purchase_events WHERE purchase_id=$1 ORDER BY revision", [purchase.id])).rows[0]!.actor_ref).toBe(d.user);
  });

  it("rejects wrong tenant, amount, link identity and late captured payment without an outbox write", async () => {
    const purchase = await paid(), valid = d.checkout!;
    for (const wrong of [{ tenantId: d.otherTenant }, { amountMinor: 100 }, { id: "plink_wrong" }, { checkoutUrl: "https://outside.test/pay" },
      // Deliberately malformed provider-edge value cannot satisfy its declared contract.
      { payments: [{ ...valid.payments[0]!, status: "authorized" }] } as unknown as Partial<CreditPurchaseCheckout>,
      { payments: [{ ...valid.payments[0]!, createdAt: "2020-01-01T00:00:00.000Z" }] },
      { payments: [{ ...valid.payments[0]!, createdAt: new Date(Date.now() + 600_000).toISOString() }] }] satisfies Partial<CreditPurchaseCheckout>[]) {
      d.checkout = { ...valid, ...wrong };
      await expect(d.service.refresh(d.tenant, d.user, purchase.id, etag(purchase))).rejects.toThrow();
      expect(await deliveries()).toEqual([]);
      expect(await d.service.get(d.tenant, d.user, purchase.id)).toEqual(purchase);
    }
  });

  it("enqueues only one immutable credit quantity for repeated captured payment and marks delivered only after the outbox acknowledgement", async () => {
    const purchase = await paid();
    const pending = await d.service.refresh(d.tenant, d.user, purchase.id, etag(purchase));
    expect(pending.state).toBe("delivery_pending"); expect(await deliveries()).toHaveLength(1);
    expect((await deliveries())[0]).toMatchObject({ payment_ref: "pay_purchaseNative", credits: 3, published_at: null });
    expect((await d.service.reconcile(d.tenant, purchase.id)).state).toBe("delivery_pending");
    expect((await d.service.reconcile(d.tenant, purchase.id)).state).toBe("delivery_pending");
    expect(await deliveries()).toHaveLength(1);
    await d.admin.query("UPDATE billing_credit_deliveries SET published_at=clock_timestamp() WHERE tenant_id=$1", [d.tenantA]);
    expect((await d.service.reconcile(d.tenant, purchase.id)).state).toBe("delivered");
    expect((await d.admin.query("SELECT revision,to_state FROM credit_purchase_events ORDER BY revision")).rows).toEqual([
      { revision: 1, to_state: "submitting" }, { revision: 2, to_state: "checkout_ready" }, { revision: 3, to_state: "delivery_pending" }, { revision: 4, to_state: "delivered" }]);
  });

  it("keeps inactive tenants out of bounded reconciliation inventory and resumes them after reactivation", async () => {
    const purchase = await create();
    const other = await d.service.create(d.otherTenant, d.otherUser, d.input, key());
    await d.admin.query("UPDATE tenants SET status='suspended' WHERE id=$1", [d.tenantA]);
    expect(await d.repository.due()).toEqual([{ tenant_id: d.tenantB, purchase_id: other.id }]);
    await expect(d.repository.reserveDue(d.tenant, purchase.id)).rejects.toMatchObject({ response: { error_code: "CREDIT_PURCHASE_TENANT_UNAVAILABLE" } });
    await d.admin.query("UPDATE tenants SET status='active' WHERE id=$1", [d.tenantA]);
    expect(await d.repository.due()).toContainEqual({ tenant_id: d.tenantA, purchase_id: purchase.id });
    expect(await d.repository.reserveDue(d.tenant, purchase.id)).toBe(true);
  });

  it("persists reconciliation backoff without changing the displayed revision or monopolizing failed inventory", async () => {
    const purchase = await create();
    expect(await d.repository.reserveDue(d.tenant, purchase.id)).toBe(true);
    expect(await d.repository.reserveDue(d.tenant, purchase.id)).toBe(false);
    expect((await d.service.get(d.tenant, d.user, purchase.id)).revision).toBe(purchase.revision);
    expect(await d.repository.due()).toEqual([]);
  });

  it("reapplies the migration without losing history, refuses nonempty downgrade and guards erasure by exact active tenant manifest", async () => {
    const purchase = await create();
    const source = readFileSync(join(__dirname, "../db/migrations/0038_credit_purchases.sql"), "utf8");
    for (const sql of source.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) await d.admin.query(sql);
    expect((await d.service.get(d.tenant, d.user, purchase.id)).id).toBe(purchase.id);
    const rollback = readFileSync(join(__dirname, "../db/migrations/rollback/0038_drop_credit_purchases.sql"), "utf8");
    await expect(d.admin.query(rollback.split("--> statement-breakpoint")[0]!)).rejects.toThrow("history must be erased");
    expect((await d.repository.transaction(d.tenant, tx => tx.query("DELETE FROM credit_purchases WHERE id=$1", [purchase.id]))).rowCount).toBe(0);
    await expect(d.admin.query("DELETE FROM credit_purchases WHERE id=$1", [purchase.id])).rejects.toThrow("guarded erasure");
    expect((await d.service.get(d.tenant, d.user, purchase.id)).id).toBe(purchase.id);
    await d.admin.query("INSERT INTO tenant_erasure_manifests(manifest_id,tenant_id) VALUES('del_00000000-0000-7000-8000-00000000d001',$1),('del_00000000-0000-7000-8000-00000000d002',$2)", [d.tenantA, d.tenantB]);
    await expect(d.pool.query("SELECT erase_tenant_credit_purchases($1,'wrong-manifest')", [d.tenantA])).rejects.toThrow("no active erasure manifest");
    const other = await d.service.create(d.otherTenant, d.otherUser, d.input, key());
    expect((await d.pool.query("SELECT erase_tenant_credit_purchases($1,'del_00000000-0000-7000-8000-00000000d001') AS n", [d.tenantA])).rows).toEqual([{ n: 3 }]);
    expect((await d.service.get(d.otherTenant, d.otherUser, other.id)).id).toBe(other.id);
  });
});
