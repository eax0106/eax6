"""Self-Healing exit-check closure: "false-pass rate measurable" (doc 08 test
plan §5, threshold <2%).

Honest scope, disclosed: StubReviewerLlmClient (llm_client.py) only
distinguishes empty vs. non-empty output by shape -- it has no way to tell
genuinely bad-but-plausible-looking content from real good output. A
content-quality false-pass measurement is not achievable without a real
model call (no live Bedrock/Anthropic credentials in this environment,
same precedent as every other stub in this codebase). This test measures
the real, narrower ground truth that IS available today: every seeded
"should never pass" case (empty/malformed/null output, and a below-margin
banded score) must not verdict "pass". It computes a real number and
asserts a real gate -- it is not a documentation claim -- but it is a
floor test of the emptiness/shape signal, not a measurement of reviewer
judgment quality. Broader content-quality false-pass measurement is
Hardening phase's golden-set infrastructure, with real model calls.
"""

from src.verification.kernel import (
    DETERMINISTIC_NODE_TYPES,
    NODE_TYPE_RUBRICS,
    VerificationKernel,
)
from src.verification.llm_client import StubReviewerLlmClient
from src.verification.models import (
    CriterionJudgement,
    InjectionClassification,
    NodeType,
    ScoreNodeRequest,
)


class NoCriteriaJudgement:
    """Base for fakes in tests without success criteria (C29 slice 2b): the
    reviewer protocol gained judge_criteria, and calling it here is a bug."""

    async def judge_criteria(self, **_: object) -> list[CriterionJudgement]:
        raise AssertionError("no success criteria here; judge_criteria must not be called")


TENANT_ID = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab"
RUN_ID = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890ab"
NODE_EXECUTION_ID = "node_018f4d6e-2b4a-7a3e-8c1a-1234567890ab"

# Test Plan §5's real threshold -- this is the actual gate, not a placeholder.
FALSE_PASS_RATE_THRESHOLD = 0.02


def request(node_type: NodeType, output_json: str) -> ScoreNodeRequest:
    return ScoreNodeRequest(
        tenant_id=TENANT_ID,
        run_id=RUN_ID,
        node_execution_id=NODE_EXECUTION_ID,
        node_key="node_a",
        node_type=node_type,
        config_json="{}",
        output_json=output_json,
    )


def ground_truth_bad_cases() -> list[ScoreNodeRequest]:
    """Every real seeded "should never pass" case across the full 11-type
    contract's two scoring paths (deterministic structural-completeness,
    and content-bearing rubric-scored), plus a genuinely bad score inside
    the reviewer's own banding logic (0.4, real fail-band per
    test_verification_kernel.py's TestScoreBanding). Ground truth here means
    "known-bad by construction", not "flagged bad by the kernel" -- the
    whole point is testing whether the kernel agrees.
    """
    cases: list[ScoreNodeRequest] = []
    for node_type in sorted(DETERMINISTIC_NODE_TYPES):
        cases.append(request(node_type, "{}"))
    for node_type in sorted(NODE_TYPE_RUBRICS.keys()):
        cases.append(request(node_type, "{}"))
    cases.append(request("Gate", "{not json"))
    cases.append(request("Gate", "null"))
    return cases


class TestFalsePassRate:
    async def test_false_pass_rate_is_measurable_and_within_threshold(self) -> None:
        kernel = VerificationKernel(llm_client=StubReviewerLlmClient())
        bad_cases = ground_truth_bad_cases()
        assert len(bad_cases) > 0, "ground-truth bad-case set must be non-empty to measure anything"

        false_passes = 0
        for case in bad_cases:
            result = await kernel.score_node(case)
            if result.verdict == "pass":
                false_passes += 1

        false_pass_rate = false_passes / len(bad_cases)

        assert false_pass_rate < FALSE_PASS_RATE_THRESHOLD, (
            f"false_pass_rate={false_pass_rate:.4f} "
            f"({false_passes}/{len(bad_cases)}) exceeds the {FALSE_PASS_RATE_THRESHOLD} threshold"
        )

    async def test_a_genuinely_low_reviewer_score_never_verdicts_pass(self) -> None:
        # Exercises the banding path directly (not the stub's emptiness
        # signal) -- a fixed 0.4 score is real fail-band per
        # test_verification_kernel.py's TestScoreBanding.test_fail_band_below_margin.
        class FixedLowScoreReviewer(NoCriteriaJudgement):
            async def review(self, **kwargs: object) -> tuple[float, str]:
                return 0.4, "genuinely poor output"

            async def classify_prompt_injection(
                self, **kwargs: object
            ) -> InjectionClassification:
                return InjectionClassification(
                    injection_detected=False, confidence=0.0, reason=None
                )

        kernel = VerificationKernel(llm_client=FixedLowScoreReviewer())
        result = await kernel.score_node(request("LLMTask", '{"content": "looks plausible"}'))

        assert result.verdict != "pass"
