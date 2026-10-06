import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { creditPurchaseAmounts } from "@alterx/contracts";
import { BillingOperationNotSubmittedError, type CreditPurchaseProviderInput } from "@alterx/shared-clients";
import { createFetchRazorpayHttpClient } from "./razorpay-billing-provider";
import { RazorpayCreditPurchaseProvider } from "./razorpay-credit-purchase-provider";

const now = new Date("2026-10-05T12:00:00.000Z");
const input: CreditPurchaseProviderInput = {
  tenantId: "ten_00000000-0000-7000-8000-000000000001",
  purchaseId: "cpx_00000000-0000-7000-8000-000000000002",
  quote: { planId: "basic", planVersion: now.toISOString(), credits: 3, unitPriceMinor: 101,
    creditsPerVerifiedRun: 2, ...creditPurchaseAmounts(3, 101) },
  gstin: "27AAPFU0939F1ZV", expiresAt: "2026-10-08T12:00:00.000Z",
};
const fixture = () => ({ id: "plink_CreditFixture", reference_id: input.purchaseId,
  notes: { tenant_id: input.tenantId, alter_credit_purchase: input.purchaseId, gstin: input.gstin },
  amount: 358, amount_paid: 0, currency: "INR", accept_partial: false, status: "created",
  short_url: "https://rzp.io/rzp/credit-fixture", payments: null });

describe("actual Razorpay credit purchase HTTP on a controlled provider edge", () => {
  let server: Server, provider: RazorpayCreditPurchaseProvider;
  let response: unknown, collection: unknown, dropPost: boolean;
  const requests: { method: string; path: string; body: unknown; authorization: string | undefined }[] = [];
  beforeEach(async () => {
    response = fixture(); collection = { payment_links: [] }; dropPost = false; requests.length = 0;
    server = createServer(async (request, reply) => {
      const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      requests.push({ method: request.method!, path: request.url!, body: body ? JSON.parse(body) : null,
        authorization: request.headers.authorization });
      if (request.method === "POST") collection = { payment_links: [response] };
      if (request.method === "POST" && dropPost) { request.socket.destroy(); return; }
      reply.setHeader("content-type", "application/json");
      reply.end(JSON.stringify(request.url!.includes("reference_id=") ? collection : response));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    provider = new RazorpayCreditPurchaseProvider({ keyIdSecretRef: "fixture/id", keySecretSecretRef: "fixture/key" },
      { getSecret: async () => "fixture-provider-key" } as never, createFetchRazorpayHttpClient(baseUrl), () => now);
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

  it("creates only the immutable configured reference and amount, with no customer notification or card vault", async () => {
    expect(await provider.create(input)).toMatchObject({ id: "plink_CreditFixture", amountMinor: 358,
      amountPaidMinor: 0, tenantId: input.tenantId, checkoutUrl: "https://rzp.io/rzp/credit-fixture", status: "created" });
    expect(requests[0]).toEqual({ method: "POST", path: "/v1/payment_links/",
      authorization: `Basic ${Buffer.from("fixture-provider-key:fixture-provider-key").toString("base64")}`,
      body: { amount: 358, currency: "INR", accept_partial: false, reference_id: input.purchaseId,
        description: "3 Alter execution credits", expire_by: Date.parse(input.expiresAt) / 1000,
        notify: { email: false, sms: false }, reminder_enable: false,
        notes: { tenant_id: input.tenantId, alter_credit_purchase: input.purchaseId, gstin: input.gstin } } });
  });
  it("finds the same committed reference after a lost POST response, with no second provider write", async () => {
    dropPost = true;
    await expect(provider.create(input)).rejects.toThrow();
    expect(await provider.find(input)).toMatchObject({ id: "plink_CreditFixture", referenceId: input.purchaseId });
    expect(requests.filter(request => request.method === "POST")).toHaveLength(1);
    expect(requests[1]!.path).toBe(`/v1/payment_links/?reference_id=${input.purchaseId}`);
    collection = { payment_links: [] }; expect(await provider.find(input)).toBeNull();
    expect(requests.filter(request => request.method === "POST")).toHaveLength(1);
  });
  it("rejects mismatched subjects, amounts, references, GSTIN, currency, provider ids and hosted URLs", async () => {
    for (const change of [{ id: "plink_Other" }, { amount: 357 }, { currency: "USD" }, { reference_id: "different" },
      { notes: { ...fixture().notes, tenant_id: "ten_00000000-0000-7000-8000-000000000099" } },
      { notes: { ...fixture().notes, gstin: null } }, { accept_partial: true }, { status: "unknown" },
      { short_url: "https://evil.test/checkout" }]) {
      response = { ...fixture(), ...change };
      await expect(provider.get(input, "plink_CreditFixture")).rejects.toThrow();
    }
    expect(requests.every(request => request.method === "GET")).toBe(true);
  });
  it("keeps lookup ambiguity and malformed collections visible instead of inventing a purchase", async () => {
    for (const body of [{ payment_links: [fixture(), fixture()] }, { payment_links: {} }, {},
      { payment_links: [{ ...fixture(), reference_id: "unrelated" }] }]) {
      collection = body; await expect(provider.find(input)).rejects.toThrow();
    }
  });
  it("retains actual bound captured payment evidence and rejects inconsistent paid or duplicate receipts", async () => {
    const captured = { payment_id: "pay_CreditFixture", plink_id: "plink_CreditFixture", amount: 358,
      status: "captured", created_at: Date.parse("2026-10-05T12:01:00.000Z") / 1000 };
    response = { ...fixture(), status: "paid", amount_paid: 358, payments: [captured] };
    expect(await provider.get(input, "plink_CreditFixture")).toMatchObject({ status: "paid", payments: [
      { id: "pay_CreditFixture", linkId: "plink_CreditFixture", amountMinor: 358, status: "captured", createdAt: "2026-10-05T12:01:00.000Z" },
    ] });
    for (const change of [{ amount_paid: 357 }, { payments: [captured, captured] }, { payments: [{ ...captured, amount: 357 }] },
      { payments: [{ ...captured, plink_id: "plink_Other" }] }, { payments: [{ ...captured, status: "authorized" }] }]) {
      response = { ...fixture(), status: "paid", amount_paid: 358, ...change };
      await expect(provider.get(input, "plink_CreditFixture")).rejects.toThrow();
    }
  });
  it("accepts documented captured receipts bound by the validated parent checkout", async () => {
    // Razorpay fetch-id-standard returns these receipt fields without plink_id.
    response = { ...fixture(), status: "paid", amount_paid: 358, payments: [{
      payment_id: "pay_CreditFixture", amount: 358, method: "card", status: "captured",
      created_at: Date.parse("2026-10-05T12:01:00.000Z") / 1000,
    }] };
    expect(await provider.get(input, "plink_CreditFixture")).toMatchObject({ status: "paid", payments: [{
      id: "pay_CreditFixture", linkId: "plink_CreditFixture", amountMinor: 358, status: "captured",
    }] });
  });
  it("fails before submission when expiry or credentials are unavailable", async () => {
    await expect(provider.create({ ...input, expiresAt: now.toISOString() })).rejects.toBeInstanceOf(BillingOperationNotSubmittedError);
    const unavailable = new RazorpayCreditPurchaseProvider({ keyIdSecretRef: "missing", keySecretSecretRef: "missing" },
      { getSecret: async () => { throw new Error("Fixture unavailable"); } } as never,
      { request: async () => { throw new Error("Must not submit"); } }, () => now);
    await expect(unavailable.create(input)).rejects.toBeInstanceOf(BillingOperationNotSubmittedError);
    expect(requests).toHaveLength(0);
  });
});
