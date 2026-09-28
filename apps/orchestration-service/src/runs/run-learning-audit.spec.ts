import { AuditServiceClient } from "@alterx/adapters";
import { describe, expect, it } from "vitest";

import { runLearningAuditClient } from "./run-learning-audit";

describe("runLearningAuditClient (design log §30, C46)", () => {
  it("refuses to start real without an audit-service address", () => {
    expect(() => runLearningAuditClient({ RUNTIME_MODE: "real" })).toThrow(
      /AUDIT_SERVICE_GRPC_ADDRESS is required/,
    );
  });

  it("writes to audit-service in real mode", () => {
    expect(
      runLearningAuditClient({ RUNTIME_MODE: "real", AUDIT_SERVICE_GRPC_ADDRESS: "127.0.0.1:50068" }),
    ).toBeInstanceOf(AuditServiceClient);
  });

  it("keeps the in-memory handler in mock mode", () => {
    expect(runLearningAuditClient({ RUNTIME_MODE: "mock" })).not.toBeInstanceOf(AuditServiceClient);
  });
});
