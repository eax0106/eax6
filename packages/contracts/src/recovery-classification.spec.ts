import { describe, expect, it } from "vitest";

import {
  FailureClassSchema,
  FailureObservationSchema,
  RootCauseEstimateSchema,
} from "./recovery-classification";

const UUID = "018f47a2-7b11-7b11-8a11-1234567890ab";

describe("recovery classification contracts", () => {
  it("locks failure classes for HEAL-6", () => {
    expect(FailureClassSchema.options).toEqual([
      "infrastructure_failure",
      "logic_output_failure",
      "timeout",
      "tool_permission_denial",
      "sandbox_crash",
      "rate_limit",
      "safety_violation",
      "credential_missing",
      "agent_creation_failure",
      "target_missing",
      "ambiguous_outcome",
      "unknown",
    ]);
  });

  it("requires real request and trace UUIDv7 context", () => {
    const valid = {
      trace_id: `trc_${UUID}`,
      request_id: `req_${UUID}`,
      error_code: "TOOL_GATEWAY_PERMISSION_DENIED",
    };
    expect(FailureObservationSchema.safeParse(valid).success).toBe(true);
    expect(
      FailureObservationSchema.safeParse({ ...valid, trace_id: "" }).success,
    ).toBe(false);
    expect(
      FailureObservationSchema.safeParse({ ...valid, request_id: UUID })
        .success,
    ).toBe(false);
  });

  it("validates structured ADVANCED-tier root-cause estimates", () => {
    expect(
      RootCauseEstimateSchema.parse({
        schema_version: "heal5.v1",
        failure_class: "logic_output_failure",
        explanation: "Generated output violated its declared shape.",
        confidence: 0.82,
        evidence: ["MODEL_GATEWAY_INVALID_RESPONSE"],
        node_attempt: 2,
        model_alias: "ADVANCED",
        resolved_capability: "ADVANCED:aws-bedrock",
      }),
    ).toBeDefined();
  });
});
