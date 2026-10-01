import type {
  FailureClass,
  FailureObservation,
} from "@alterx/contracts";

export interface FailedNodeEvidence {
  readonly nodeType: string;
  readonly attempt: number;
  readonly error: Readonly<Record<string, unknown>>;
}

export interface FailureClassification {
  readonly failureClass: FailureClass;
  readonly confidenceCeiling: number;
  readonly evidence: readonly string[];
}

type Scores = Map<FailureClass, number>;

export function classifyNodeFailure(
  node: FailedNodeEvidence,
  observation: FailureObservation,
): FailureClassification {
  const scores: Scores = new Map();
  const evidence = new Map<FailureClass, string[]>();
  const codes = errorCodes(node.error, observation);
  const detail = [
    safeString(node.error["detail"]),
    safeString(node.error["message"]),
    observation.detail,
    observation.verification?.detail,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");

  // Explicit uncertain side effects must not become retryable timeouts.
  const safetySignal = codes.some(code => /SAFETY|POLICY_VIOLATION|HALLUCINATION/.test(code)) ||
    observation.safety_severity === "high" || observation.safety_severity === "critical";
  if (!safetySignal) {
    const ambiguous = codes.find(code => /AMBIGUOUS_OUTCOME/.test(code));
    if (ambiguous !== undefined) return { failureClass: "ambiguous_outcome", confidenceCeiling: 0.98, evidence: [`error_code=${ambiguous}`] };
    const missing = codes.find(code => /TARGET_MISSING|TARGET_NOT_FOUND|RESOURCE_NOT_FOUND/.test(code));
    if (missing !== undefined) return { failureClass: "target_missing", confidenceCeiling: 0.98, evidence: [`error_code=${missing}`] };
  }

  for (const code of codes) {
    if (/PERMISSION_DENIED|FORBIDDEN|CREDENTIAL.*DENIED/.test(code)) {
      add(scores, evidence, "tool_permission_denial", 100, `error_code=${code}`);
    }
    if (/TIMEOUT|TIMED_OUT|DEADLINE_EXCEEDED/.test(code)) {
      add(scores, evidence, "timeout", 100, `error_code=${code}`);
    }
    if (/RATE_LIMIT|RESOURCE_EXHAUSTED|THROTTL/.test(code)) {
      add(scores, evidence, "rate_limit", 100, `error_code=${code}`);
    }
    if (/SANDBOX.*(?:CRASH|TERMINATED|SESSION_LOST)/.test(code)) {
      add(scores, evidence, "sandbox_crash", 100, `error_code=${code}`);
    }
    if (/SAFETY|POLICY_VIOLATION|HALLUCINATION/.test(code)) {
      add(scores, evidence, "safety_violation", 100, `error_code=${code}`);
    }
    if (
      /INFRA|UNAVAILABLE|NETWORK|ECONN|ENOTFOUND|INTERNAL_ERROR/.test(code)
    ) {
      add(
        scores,
        evidence,
        "infrastructure_failure",
        90,
        `error_code=${code}`,
      );
    }
    if (/LOGIC|INVALID_RESPONSE|BAD_OUTPUT|OUTPUT_INVALID|PLACEHOLDER/.test(code)) {
      add(
        scores,
        evidence,
        "logic_output_failure",
        90,
        `error_code=${code}`,
      );
    }
    if (/AGENT_CREATION_FAILED/.test(code)) {
      add(scores, evidence, "agent_creation_failure", 100, `error_code=${code}`);
    }
  }

  const verification = observation.verification;
  if (verification?.status === "infra_failure") {
    add(
      scores,
      evidence,
      "infrastructure_failure",
      80,
      `verification.${verification.kind}=infra_failure`,
    );
  }
  if (verification?.status === "logic_failure") {
    add(
      scores,
      evidence,
      "logic_output_failure",
      80,
      `verification.${verification.kind}=logic_failure`,
    );
  }

  if (
    observation.safety_severity === "high" ||
    observation.safety_severity === "critical"
  ) {
    add(
      scores,
      evidence,
      "safety_violation",
      100,
      `HEAL-3 safety_severity=${observation.safety_severity}`,
    );
  }

  if (/timeout|timed out|deadline exceeded/i.test(detail)) {
    add(scores, evidence, "timeout", 75, "detail matched timeout signature");
  }
  if (/CREDENTIAL_MISSING/i.test(detail)) {
    add(scores, evidence, "credential_missing", 100, "detail matched CREDENTIAL_MISSING signature");
  }
  if (
    node.nodeType === "SandboxExec" &&
    /sandbox.*(?:unavailable|crash|terminated|session.*(?:lost|missing|not found))/i.test(
      detail,
    )
  ) {
    add(
      scores,
      evidence,
      "sandbox_crash",
      85,
      "SandboxExec detail matched unavailable/crash signature",
    );
  }
  if (observation.retryable === true || node.error["retryable"] === true) {
    add(
      scores,
      evidence,
      "infrastructure_failure",
      15,
      "failure marked retryable",
    );
  }

  const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1]);
  const winner = ranked[0];
  if (winner === undefined) {
    return {
      failureClass: "unknown",
      confidenceCeiling: 0.25,
      evidence: ["no deterministic failure signature matched"],
    };
  }
  const tied = ranked.filter(([, score]) => score === winner[1]);
  if (tied.length > 1) {
    return {
      failureClass: "unknown",
      confidenceCeiling: 0.25,
      evidence: [
        `conflicting top signals: ${tied.map(([failureClass]) => failureClass).join(", ")}`,
      ],
    };
  }

  const runnerUp = ranked[1]?.[1] ?? 0;
  const margin = winner[1] - runnerUp;
  const confidenceCeiling =
    winner[1] >= 100 && margin >= 20
      ? 0.98
      : winner[1] >= 80 && margin >= 20
        ? 0.9
        : 0.7;
  return {
    failureClass: winner[0],
    confidenceCeiling,
    evidence: (evidence.get(winner[0]) ?? []).slice(0, 8),
  };
}

function add(
  scores: Scores,
  evidence: Map<FailureClass, string[]>,
  failureClass: FailureClass,
  score: number,
  reason: string,
): void {
  scores.set(failureClass, (scores.get(failureClass) ?? 0) + score);
  evidence.set(failureClass, [...(evidence.get(failureClass) ?? []), reason]);
}

function errorCodes(
  error: Readonly<Record<string, unknown>>,
  observation: FailureObservation,
): readonly string[] {
  return [
    safeString(error["code"]),
    safeString(error["error_code"]),
    observation.error_code,
    observation.verification?.error_code,
  ]
    .filter((value): value is string => value !== undefined)
    .map((value) => value.trim().toUpperCase());
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.slice(0, 2_048)
    : undefined;
}
