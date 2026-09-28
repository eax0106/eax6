import type {
  ScoreNodeInlineRequest,
  ScoreNodeInlineResponse,
} from "@alterx/contracts";
import type { VerifyServiceHandlerClient } from "@alterx/adapters";

export class VerifyGateError extends Error {
  constructor(
    readonly code: "VERIFICATION_GATE_FAILED" | "VERIFY_SERVICE_UNAVAILABLE" | "SAFETY_VIOLATION",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * Design log §4: a safety violation is not a failure Recovery handles. Its
 * instinct is to keep going, which re-exposes the same attack path, so the
 * whole workflow halts before Recovery is ever invoked. The gate reports one
 * by its reviewer model: output classified as a prompt injection is never
 * reviewed, only blocked.
 */
export const SAFETY_BLOCKED_REVIEWER_MODEL = "injection-blocked";

export class SafetyViolationError extends VerifyGateError {
  constructor(message: string) {
    super("SAFETY_VIOLATION", message);
    this.name = "SafetyViolationError";
  }
}

export class VerifyGateService {
  constructor(private readonly client: VerifyServiceHandlerClient) {}

  async scoreNodeInline(
    request: ScoreNodeInlineRequest,
  ): Promise<ScoreNodeInlineResponse> {
    try {
      return await this.client.scoreNodeInline(request);
    } catch (error: unknown) {
      // The code is what callers switch on and what persistedError stores, so
      // it stays put. The message did not: discarding the error reported every
      // failure as the service being unreachable, including the ones where it
      // answered and rejected the request. Carry the real reason so the row in
      // node_executions.error says what actually happened.
      const reason = error instanceof Error ? error.message : String(error);
      throw new VerifyGateError(
        "VERIFY_SERVICE_UNAVAILABLE",
        `Verify Service call failed: ${reason}`,
        { cause: error },
      );
    }
  }
}
