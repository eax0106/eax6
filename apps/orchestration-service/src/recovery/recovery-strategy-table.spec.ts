import { describe, expect, it } from "vitest";

import type { FailureClass } from "@alterx/contracts";

import {
  POLICY_ID,
  POLICY_VERSION,
  parsePolicyRules,
  selectRecoveryStrategy,
  type ActivePolicy,
  type RecoveryStrategy,
} from "./recovery-strategy-table";

const ALL_FAILURE_CLASSES: readonly FailureClass[] = [
  "infrastructure_failure",
  "logic_output_failure",
  "timeout",
  "tool_permission_denial",
  "sandbox_crash",
  "rate_limit",
  "safety_violation",
  "agent_creation_failure",
  "target_missing",
  "ambiguous_outcome",
  "unknown",
];

describe("selectRecoveryStrategy", () => {
  it("never throws for any locked FailureClassSchema value (exhaustiveness guarantee)", () => {
    for (const failureClass of ALL_FAILURE_CLASSES) {
      expect(() => selectRecoveryStrategy(failureClass, 1)).not.toThrow();
      expect(() => selectRecoveryStrategy(failureClass, 5)).not.toThrow();
    }
  });

  it("always returns the current policy id and version", () => {
    const decision = selectRecoveryStrategy("timeout", 1);
    expect(decision.policyId).toBe(POLICY_ID);
    expect(decision.policyVersion).toBe(POLICY_VERSION);
  });

  it("is deterministic: same inputs always produce the same strategy", () => {
    for (const failureClass of ALL_FAILURE_CLASSES) {
      const first = selectRecoveryStrategy(failureClass, 2);
      const second = selectRecoveryStrategy(failureClass, 2);
      expect(second.strategy).toBe(first.strategy);
    }
  });

  it.each([
    ["tool_permission_denial", 1, "ask_user"],
    ["tool_permission_denial", 5, "ask_user"],
    ["rate_limit", 1, "backoff"],
    ["timeout", 1, "retry"],
    ["timeout", 2, "swap_agent"],
    ["infrastructure_failure", 1, "retry"],
    ["infrastructure_failure", 2, "swap_agent"],
    ["sandbox_crash", 1, "retry"],
    ["sandbox_crash", 2, "recompile"],
    ["logic_output_failure", 1, "escalate_model"],
    ["logic_output_failure", 2, "replan"],
    ["safety_violation", 1, "ask_user"],
    ["safety_violation", 5, "ask_user"],
    ["agent_creation_failure", 1, "swap_agent"],
    ["agent_creation_failure", 2, "ask_user"],
    ["unknown", 1, "ask_user"],
  ] as const)(
    "%s at attempt %i selects %s",
    (failureClass, attempt, expected: RecoveryStrategy) => {
      expect(selectRecoveryStrategy(failureClass, attempt).strategy).toBe(expected);
    },
  );

  it("never auto-selects terminate (no real severity signal reaches this table -- see known-gap doc comment)", () => {
    for (const failureClass of ALL_FAILURE_CLASSES) {
      for (const attempt of [1, 2, 3, 10]) {
        expect(selectRecoveryStrategy(failureClass, attempt).strategy).not.toBe(
          "terminate",
        );
      }
    }
  });

  it("never selects repair (undefined concept -- disclosed, not invented)", () => {
    for (const failureClass of ALL_FAILURE_CLASSES) {
      for (const attempt of [1, 2, 3, 10]) {
        expect(selectRecoveryStrategy(failureClass, attempt).strategy).not.toBe(
          "repair",
        );
      }
    }
  });

  describe("with a real active policy override", () => {
    const policy: ActivePolicy = {
      policyId: "pol_promoted",
      policyVersion: "3",
      rules: { timeout: "backoff" },
    };

    it("promoting a new policy version measurably changes the returned strategy", () => {
      expect(selectRecoveryStrategy("timeout", 1).strategy).toBe("retry");
      expect(selectRecoveryStrategy("timeout", 1, policy).strategy).toBe("backoff");
    });

    it("returns the real promoted policy's id and version, not the fallback constants", () => {
      const decision = selectRecoveryStrategy("timeout", 1, policy);
      expect(decision.policyId).toBe("pol_promoted");
      expect(decision.policyVersion).toBe("3");
    });

    it("falls through to the deterministic default for a failure_class the policy has no rule for", () => {
      const decision = selectRecoveryStrategy("rate_limit", 1, policy);
      expect(decision.strategy).toBe("backoff");
      expect(decision.policyId).toBe(POLICY_ID);
      expect(decision.policyVersion).toBe(POLICY_VERSION);
    });

    it("supports a real [firstAttempt, laterAttempt] rule pair, not just a single strategy", () => {
      const pairPolicy: ActivePolicy = {
        policyId: "pol_pair",
        policyVersion: "1",
        rules: { sandbox_crash: ["ask_user", "terminate"] },
      };
      expect(selectRecoveryStrategy("sandbox_crash", 1, pairPolicy).strategy).toBe(
        "ask_user",
      );
      expect(selectRecoveryStrategy("sandbox_crash", 5, pairPolicy).strategy).toBe(
        "terminate",
      );
    });
  });

  describe("parsePolicyRules", () => {
    it("parses the real HEAL-6 seed body verbatim", () => {
      const rules = parsePolicyRules(
        JSON.stringify({
          policy_version: "heal6-deterministic-v1",
          rules: {
            safety_violation: "ask_user",
            rate_limit: "backoff",
            timeout: ["retry", "swap_agent"],
          },
        }),
      );
      expect(rules.safety_violation).toBe("ask_user");
      expect(rules.rate_limit).toBe("backoff");
      expect(rules.timeout).toEqual(["retry", "swap_agent"]);
    });

    it("skips one malformed rule entry without discarding the rest of the policy", () => {
      const rules = parsePolicyRules(
        JSON.stringify({
          rules: {
            timeout: "not_a_real_strategy",
            rate_limit: "backoff",
          },
        }),
      );
      expect(rules.timeout).toBeUndefined();
      expect(rules.rate_limit).toBe("backoff");
    });

    it("returns an empty rule set for unparseable JSON instead of throwing", () => {
      expect(parsePolicyRules("not json")).toEqual({});
    });

    it("returns an empty rule set when the body has no 'rules' key", () => {
      expect(parsePolicyRules(JSON.stringify({ policy_version: "x" }))).toEqual({});
    });
  });
});

 it.each(["target_missing", "ambiguous_outcome"] as const)("keeps %s on the human route for every attempt and policy", failureClass => {
   for (const attempt of [1, 2, 10]) {
     expect(selectRecoveryStrategy(failureClass, attempt).strategy).toBe("ask_user");
     for (const strategy of ["retry", "swap_agent", "replan", "backoff"] as const) {
       expect(selectRecoveryStrategy(failureClass, attempt, { policyId: "pol_override", policyVersion: "2", rules: { [failureClass]: strategy } }).strategy).toBe("ask_user");
     }
   }
 });
