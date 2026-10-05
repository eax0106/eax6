import { describe, expect, it } from "vitest";
import {
  CreateJitGrantRequestSchema,
  FeatureFlagNameSchema,
  MarketplaceGovernanceActionRequestSchema,
  MarketplaceGovernanceItemSchema,
  RefundPaymentRequestSchema,
  ResolveDisputeRequestSchema,
  UpdateModelAliasRequestSchema,
  UpdateProviderControlRequestSchema,
} from "./operations";

describe("Operations contracts", () => {
  it("requires explicit JIT scopes and bounded lifetime", () => {
    const input = {
      staff_user_id: "stf_support",
      tenant_id: "f0204070-2fd2-4bb7-a117-3222301822fe",
      reason_code: "support_case",
      reason_text: "Investigate failed workflow",
      duration_minutes: 30,
      scopes: ["runs:read"],
    };
    expect(CreateJitGrantRequestSchema.parse(input)).toEqual(input);
    expect(() => CreateJitGrantRequestSchema.parse({ ...input, scopes: [] })).toThrow();
    expect(() => CreateJitGrantRequestSchema.parse({ ...input, duration_minutes: 481 })).toThrow();
  });

  it("rejects provider updates with no real control change", () => {
    expect(() => UpdateProviderControlRequestSchema.parse({ reason: "none" })).toThrow();
    expect(UpdateProviderControlRequestSchema.parse({
      active: false,
      reason: "provider incident",
    })).toMatchObject({ active: false });
  });

  it("validates separate feature-flag and model-policy writes", () => {
    expect(FeatureFlagNameSchema.parse("operations.kill-switch")).toBe(
      "operations.kill-switch",
    );
    expect(() => FeatureFlagNameSchema.parse("Operations flag")).toThrow();
    expect(UpdateModelAliasRequestSchema.parse({
      binding: {
        model_id: "anthropic.claude-sonnet-5",
        capability_tags: ["general"],
      },
      reason: "provider maintenance",
    }).binding.model_id).toBe("anthropic.claude-sonnet-5");
  });

  it("requires positive minor units for refunds", () => {
    expect(() => RefundPaymentRequestSchema.parse({
      payment_ref: "pay_123",
      amount_minor: 0,
      reason: "duplicate payment",
    })).toThrow();
  });

  it("requires evidence when contesting a dispute", () => {
    expect(() => ResolveDisputeRequestSchema.parse({
      action: "contest",
      reason: "service delivered",
    })).toThrow();
    expect(ResolveDisputeRequestSchema.parse({
      action: "accept",
      reason: "claim valid",
    }).evidence_refs).toEqual([]);
  });

  it("binds trust levels only to set_trust", () => {
    expect(() => MarketplaceGovernanceActionRequestSchema.parse({
      action: "takedown",
      reason: "malware",
      trust_level: "blocked",
    })).toThrow();
  });

  it("types real marketplace governance queue resources", () => {
    expect(MarketplaceGovernanceItemSchema.parse({
      resource_type: "tool_manifest",
      id: "tlm_123",
      tenant_id: "f0204070-2fd2-4bb7-a117-3222301822fe",
      name: "Package",
      status: "blocked",
      trust_level: "blocked",
      updated_at: "2026-08-06T10:00:00.000Z",
    }).resource_type).toBe("tool_manifest");
  });

  it("validates advisory risk and attributed requested-change history without breaking older queues", () => {
    const item = { resource_type: "listing", id: "lst_review", tenant_id: "ten_f0204070-2fd2-7bb7-a117-3222301822fe", name: "Mapping", status: "needs_changes", trust_level: null, updated_at: "2026-10-05T00:00:00.000Z",
      etag: '"revision-1"', risk: { score: 15, incomplete: true, reasons: [{ signal: "first_listing", points: 15, detail: "First listing", evidence: [], observed: true }] },
      review_notes: [{ id: "mge_note", actor_type: "staff", actor_ref: "stf_reviewer", action: "needs_changes", previous_status: "human_review", next_status: "needs_changes", reason: "Explain fields", occurred_at: "2026-10-05T00:00:00.000Z" }] };
    expect(MarketplaceGovernanceItemSchema.parse(item)).toEqual(item);
    for (const score of [-1, 101, 1.5]) expect(() => MarketplaceGovernanceItemSchema.parse({ ...item, risk: { ...item.risk, score } })).toThrow();
    expect(() => MarketplaceGovernanceItemSchema.parse({ ...item, risk: { ...item.risk, approve: true } })).toThrow();
    expect(() => MarketplaceGovernanceItemSchema.parse({ ...item, review_notes: [{ ...item.review_notes[0], actor_type: "unknown" }] })).toThrow();
    expect(MarketplaceGovernanceActionRequestSchema.parse({ action: "needs_changes", reason: " Correct fields " }).reason).toBe("Correct fields");
    for (const reason of [" ", "x".repeat(1001)]) expect(() => MarketplaceGovernanceActionRequestSchema.parse({ action: "needs_changes", reason })).toThrow();
  });
});
