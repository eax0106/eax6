"""LLM client contract and stub for the ADVANCED-tier reviewer.

The Verification & Quality Gate calls the Model Gateway
(alter.modelgw.v1.ModelgwService) for its reviewer scoring. The real gRPC
client lives in packages/adapters (vendor-SDK rule); this module defines
only the Protocol the verification kernel depends on and a
contract-complete stub that returns deterministic responses -- same
pattern as apps/intelligence-service/src/planner/llm_client.py.

Wire the stub during development. Swap in the real adapter at integration
time without touching kernel.py.
"""

from typing import Protocol, runtime_checkable

from .models import CriterionJudgement, InjectionClassification

# Alter LLM alias vocabulary (doc 13 sec 2) -- components never name a
# model, only an alias; Model Gateway resolves the actual provider/model
# via policy. Doc 03 sec 4.1 assigns Verification & Quality Gate's reviewer
# to ADVANCED tier.
MODEL_ALIAS_ADVANCED = "ADVANCED"


@runtime_checkable
class ReviewerLlmClient(Protocol):
    """Narrow interface the verification kernel requires from the Model Gateway."""

    async def review(
        self,
        *,
        tenant_id: str,
        run_id: str,
        node_execution_id: str,
        node_type: str,
        rubric: str,
        config_json: str,
        output_json: str,
    ) -> tuple[float, str]:
        """Score a node's output against its rubric.

        Returns (score in [0.0, 1.0], rationale).
        """
        ...

    async def judge_criteria(
        self,
        *,
        tenant_id: str,
        run_id: str,
        node_execution_id: str,
        node_type: str,
        criteria: tuple[str, ...],
        config_json: str,
        output_json: str,
    ) -> list[CriterionJudgement]:
        """C29. Judge the output against each of the producing node's success
        criteria. Returns exactly one judgement per criterion, in order."""
        ...

    async def classify_prompt_injection(
        self,
        *,
        tenant_id: str,
        run_id: str,
        node_execution_id: str,
        text: str,
    ) -> InjectionClassification:
        """ENGINE-FIX-P3-15. Classify text (the node output about to be
        reviewed) for prompt injection before it reaches the ADVANCED
        reviewer -- anyone who can shape a node's output can otherwise
        shape its own verification result. Must fail open (never detected)
        on its own malfunction, same reasoning as the TypeScript
        PromptInjectionClassifier this mirrors: a defense-in-depth guard
        must not become a single point of failure for the whole quality
        gate.
        """
        ...


class StubReviewerLlmClient:
    """Contract-complete stub. Scores deterministically from output shape.

    Used during development before the real Model Gateway adapter is
    wired. Never calls any external service. Non-empty, JSON-object output
    scores high (0.9); empty/blank output scores low (0.1) -- just enough
    signal to prove the kernel's banding/dispatch logic end-to-end without
    a real LLM call.
    """

    async def review(
        self,
        *,
        tenant_id: str,
        run_id: str,
        node_execution_id: str,
        node_type: str,
        rubric: str,
        config_json: str,
        output_json: str,
    ) -> tuple[float, str]:
        stripped = output_json.strip()
        if stripped in ("", "{}", "null"):
            return 0.1, "Stub reviewer: output is empty or contains no content."
        return 0.9, "Stub reviewer: output is present and non-empty."

    async def judge_criteria(
        self,
        *,
        tenant_id: str,
        run_id: str,
        node_execution_id: str,
        node_type: str,
        criteria: tuple[str, ...],
        config_json: str,
        output_json: str,
    ) -> list[CriterionJudgement]:
        # Same shape heuristic as review(): an empty output meets nothing.
        met = output_json.strip() not in ("", "{}", "null")
        return [
            CriterionJudgement(
                criterion=criterion,
                met=met,
                reason="Stub reviewer: " + ("output is present." if met else "output is empty."),
            )
            for criterion in criteria
        ]

    async def classify_prompt_injection(
        self,
        *,
        tenant_id: str,
        run_id: str,
        node_execution_id: str,
        text: str,
    ) -> InjectionClassification:
        # Deterministic stub trigger, same "just enough signal to prove
        # kernel logic end-to-end" spirit as review()'s own heuristic.
        lowered = text.lower()
        if "ignore" in lowered and ("rubric" in lowered or "instruction" in lowered):
            return InjectionClassification(
                injection_detected=True,
                confidence=0.9,
                reason="Stub classifier: output attempts to override review instructions.",
            )
        return InjectionClassification(injection_detected=False, confidence=0.0, reason=None)
