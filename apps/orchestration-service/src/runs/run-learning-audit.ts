import { AuditServiceClient } from "@alterx/adapters";
import { createMockAuditEventHandler, type AuditEventHandler } from "@alterx/shared-clients";

import { internalM2mTokenProvider } from "../orchestration-infrastructure.module";
import { AUDIT_EVENTS_CLIENT_PROTO_PATH } from "../registry/nodeexec-grpc.constants";

/**
 * Design log §30: service-asserted tenants are audited. A mock runtime keeps
 * the in-memory handler; a real one writes to audit-service and requires its
 * address rather than silently falling back (design log §7 pattern 2).
 */
export function runLearningAuditClient(environment: NodeJS.ProcessEnv): AuditEventHandler {
  if ((environment.RUNTIME_MODE?.trim() || "mock") !== "real") {
    return createMockAuditEventHandler();
  }
  const address = environment.AUDIT_SERVICE_GRPC_ADDRESS?.trim();
  if (!address) {
    throw new Error("AUDIT_SERVICE_GRPC_ADDRESS is required when RUNTIME_MODE is real");
  }
  return new AuditServiceClient({
    address,
    protoPath: AUDIT_EVENTS_CLIENT_PROTO_PATH,
    accessTokenProvider: internalM2mTokenProvider(),
  });
}
