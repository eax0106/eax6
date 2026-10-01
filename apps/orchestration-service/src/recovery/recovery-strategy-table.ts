import type { FailureClass } from "@alterx/contracts";

/**
 * The 10 DB-locked values on recovery_actions.strategy (0014/0017
 * migrations). "retry" and "backoff" are two distinct strategies, not one
 * "retry+backoff" pair -- backoff is reserved for rate-limit-shaped
 * failures that need spacing, retry is for a plain transient re-attempt.
 */
export type RecoveryStrategy =
  | "repair"
  | "retry"
  | "backoff"
  | "swap_agent"
  | "escalate_model"
  | "recompile"
  | "replan"
  | "degrade"
  | "ask_user"
  | "terminate";

/**
 * Real dispatch exists today (RecoveryDispatchService) for these 9.
 * `recompile` shares `replan`'s real mechanism (no narrower
 * "recompile without a new plan" primitive exists -- Self-Healing
 * exit-check closure, disclosed merge, not two independent paths).
 * `retry`/`backoff` send a real nodeRetryDecidedSignal to the run's
 * Executor workflow (Self-Healing exit-check closure -- see
 * executor-workflow.ts's executeNodeWithRecovery). `repair` raises a real
 * escalation naming the connection the step could not authenticate with,
 * and leaves the run parked in that same wait: nothing here holds a
 * tenant's third-party credential and nothing should invent one
 * (decision 6). The remaining one, `swap_agent`, is selected correctly by
 * the deterministic table below (a real, auditable decision lands in
 * recovery_actions.strategy) but has no real system to call yet --
 * dispatch honestly reports it as deferred instead of pretending to have
 * acted.
 */
export const DISPATCHABLE_STRATEGIES = new Set<RecoveryStrategy>([
  "escalate_model",
  "replan",
  "recompile",
  "retry",
  "backoff",
  "degrade",
  "ask_user",
  "terminate",
  "repair",
]);

/**
 * Real identifier for the seeded HEAL-6 policy row (Knowledge phase,
 * memory-service's policy_db, migration 0002). Used as the fallback
 * decision's id/version whenever no real policy is passed to
 * `selectRecoveryStrategy` (or the passed policy has no rule for this
 * failure_class) -- this is real data identifying the row that seeded
 * exactly this deterministic table as its initial body, not a stub.
 */
export const POLICY_ID = "pol_00000000-0000-7000-8000-000000000001";
export const POLICY_VERSION = "heal6-deterministic-v1";

const RECOVERY_STRATEGIES = new Set<RecoveryStrategy>([
  "repair",
  "retry",
  "backoff",
  "swap_agent",
  "escalate_model",
  "recompile",
  "replan",
  "degrade",
  "ask_user",
  "terminate",
]);

function isRecoveryStrategy(value: unknown): value is RecoveryStrategy {
  return typeof value === "string" && RECOVERY_STRATEGIES.has(value as RecoveryStrategy);
}

/** A rule is either one strategy for every attempt, or a real
 * [firstAttempt, laterAttempt] pair -- mirrors this table's own existing
 * `nodeAttempt <= 1 ? x : y` escalation pattern below, just expressed as
 * real policy data instead of hardcoded. */
export type PolicyRule = RecoveryStrategy | readonly [RecoveryStrategy, RecoveryStrategy];
export type PolicyRules = Partial<Record<FailureClass, PolicyRule>>;

/**
 * Parses memory-service's real `policies.body` JSON (the exact shape
 * migration 0002 seeded: `{"rules": {"<failure_class>": "<strategy>" |
 * ["<first_attempt_strategy>", "<later_attempt_strategy>"]}}`).
 *
 * A malformed individual entry is silently skipped (that one failure_class
 * falls through to the deterministic default below), not a reason to
 * discard the whole policy -- and a totally unparseable body returns `{}`,
 * which has the same effect (every failure_class falls through). Never
 * throws; a Policy Store read is always allowed to be less trustworthy
 * than the deterministic fallback it's overriding.
 */
export function parsePolicyRules(bodyJson: string): PolicyRules {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyJson);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {};
  }
  const rulesRaw = (parsed as Record<string, unknown>).rules;
  if (typeof rulesRaw !== "object" || rulesRaw === null) {
    return {};
  }
  const rules: Record<string, PolicyRule> = {};
  for (const [failureClass, value] of Object.entries(rulesRaw as Record<string, unknown>)) {
    if (isRecoveryStrategy(value)) {
      rules[failureClass] = value;
    } else if (
      Array.isArray(value) &&
      value.length === 2 &&
      isRecoveryStrategy(value[0]) &&
      isRecoveryStrategy(value[1])
    ) {
      rules[failureClass] = [value[0], value[1]] as const;
    }
  }
  return rules;
}

export interface ActivePolicy {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly rules: PolicyRules;
}

export interface StrategyDecision {
  readonly strategy: RecoveryStrategy;
  readonly policyId: string;
  readonly policyVersion: string;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled failure_class in policy table: ${String(value)}`);
}

/**
 * Deterministic (doc 11 HEAL-5/6 law: no LLM decides the strategy itself --
 * HEAL-5 already spent its ADVANCED call on root-cause estimation only).
 * Escalates on repeat attempts of the same node rather than retrying the
 * same failure class forever.
 *
 * Known gap: `RootCauseEstimateSchema` (the locked HEAL-5 -> HEAL-6
 * handoff) does not persist HEAL-3's optional `safety_severity` signal --
 * only `FailureObservationSchema` carries it, and that observation is not
 * stored on `recovery_actions`. Auto-terminating on "critical" severity
 * therefore has no real data to read at this point and is NOT implemented
 * here: every `safety_violation` routes to `ask_user` so a human makes the
 * terminate call, rather than this table guessing at a severity it can't
 * see. Carrying `safety_severity` through to `recovery_actions` is a
 * disclosed follow-up, not something to invent silently here.
 *
 * `policy` is optional and, when present, real: a rule found for this
 * failure_class in `policy.rules` overrides the hardcoded default below,
 * except D13 missing/ambiguous outcomes, which always require a person.
 * and the returned `policyId`/`policyVersion` reflect that real promoted
 * policy row, not the fallback constants. No rule for this failure_class
 * (or no `policy` at all -- e.g. the caller never reached memory-service,
 * or the seeded row's own body has no override) falls through to the
 * exact same deterministic `decide()` this function has always used.
 * This is the real wiring: promoting a new active policy version with a
 * different `rules[failure_class]` measurably changes what this function
 * returns on the very next call, no restart or redeploy needed.
 */
export function selectRecoveryStrategy(
  failureClass: FailureClass,
  nodeAttempt: number,
  policy?: ActivePolicy,
): StrategyDecision {
  // D13: these outcomes require a person, regardless of a promoted policy.
  if (failureClass === "target_missing" || failureClass === "ambiguous_outcome") {
    return { strategy: "ask_user", policyId: POLICY_ID, policyVersion: POLICY_VERSION };
  }
  if (policy !== undefined) {
    const rule = policy.rules[failureClass];
    if (rule !== undefined) {
      const strategy = Array.isArray(rule) ? (nodeAttempt <= 1 ? rule[0] : rule[1]) : rule;
      return { strategy, policyId: policy.policyId, policyVersion: policy.policyVersion };
    }
  }
  const strategy = decide(failureClass, nodeAttempt);
  return { strategy, policyId: POLICY_ID, policyVersion: POLICY_VERSION };
}

function decide(failureClass: FailureClass, nodeAttempt: number): RecoveryStrategy {
  switch (failureClass) {
    case "credential_missing":
      return "repair";
    case "safety_violation":
      // See known-gap note above: severity isn't available here, so this
      // never auto-selects "terminate" -- a human decides that escalation.
      return "ask_user";
    case "tool_permission_denial":
      // A human/credential-owner action is required; never auto-retryable.
      return "ask_user";
    case "rate_limit":
      return "backoff";
    case "timeout":
      return nodeAttempt <= 1 ? "retry" : "swap_agent";
    case "infrastructure_failure":
      return nodeAttempt <= 1 ? "retry" : "swap_agent";
    case "sandbox_crash":
      return nodeAttempt <= 1 ? "retry" : "recompile";
    case "logic_output_failure":
      return nodeAttempt <= 1 ? "escalate_model" : "replan";
    case "agent_creation_failure":
      // First attempt: try a fresh ranked-match/auto-creation via a
      // different agent (swap_agent) rather than retrying the exact same
      // no-match situation. Repeat failure means no real agent exists for
      // this requirement -- a human must intervene, not another retry.
      return nodeAttempt <= 1 ? "swap_agent" : "ask_user";
    case "target_missing":
    case "ambiguous_outcome":
    case "unknown":
      return "ask_user";
    default:
      return assertNever(failureClass);
  }
}
