"""Verification & Quality Gate kernel: ADVANCED-tier reviewer scoring.

Implements the one operation exposed by alter.verification.v1.VerificationService:
  - score_node -- node output -> verdict/score/threshold/reviewer_model/details

Independent per-node-type grading (HEAL-2): content-bearing node types
(LLMTask, ToolCall, SandboxExec, Synthesis) are judged by an ADVANCED-tier
reviewer against a rubric tailored to that node type. Deterministic/
control-flow node types (Gate, Merge, PubSub, HumanApproval, GroupChat,
YAMLImport, MemoryWrite) get a structural completeness check instead --
an LLM judgment call on a boolean routing decision is meaningless, and
Sandbox Service already owns SandboxExec's build/render/placeholder gates
(different gate_types, EXEC-11/13) -- this kernel only adds the "quality"
gate_type on top of those.

All external I/O (the reviewer LLM) is injected; the kernel itself is pure
Python and has no side effects beyond calling that injected collaborator.
It does not persist to verification_results -- that table lives in
orchestration_db (a different service's database per the one-DB-per-service
rule); the caller (Executor/NodeexecService) owns writing this response
into that table, the same way NodeexecService owns node_executions writes.
"""

import json

from .llm_client import MODEL_ALIAS_ADVANCED, ReviewerLlmClient
from .models import CriterionJudgement, NodeType, ScoreNodeRequest, ScoreNodeResponse, Verdict
from .policy_client import QualityThresholdPolicyClient

DEFAULT_THRESHOLD = 0.7
# Verdict banding: score >= threshold -> pass; within this margin below
# threshold -> warn (borderline, flagged but not blocking); further below
# -> fail. Real per-tenant tuning now reads memory-service's Policy Store
# quality_thresholds kind (see policy_client.py) when a policy_client is
# injected; these constants remain the fallback when no policy_client is
# configured or no active policy row exists for the tenant.
WARN_MARGIN = 0.15

REVIEWER_MODEL_DETERMINISTIC = "deterministic"
# ENGINE-FIX-P3-15: distinct from MODEL_ALIAS_ADVANCED so a blocked verdict
# is honestly distinguishable in logs/details_json from a real reviewer
# score -- this output never reached the ADVANCED reviewer at all.
REVIEWER_MODEL_INJECTION_BLOCKED = "injection-blocked"

# Node types whose "quality" gate is a deterministic structural check, not
# an ADVANCED-reviewer judgment call: they route/merge/gate data rather
# than generate judgment-laden content.
DETERMINISTIC_NODE_TYPES: frozenset[NodeType] = frozenset(
    {
        "Gate",
        "HumanApproval",
        "Merge",
        "MemoryWrite",
        "PubSub",
        "GroupChat",
        "YAMLImport",
    }
)

# Per-node-type grading rubric for every content-bearing node type. Kept as
# plain text (not structured criteria) because the ADVANCED reviewer is an
# LLM call: the rubric is prompt content, not application logic.
NODE_TYPE_RUBRICS: dict[NodeType, str] = {
    "LLMTask": (
        "Judge whether the generated text directly and coherently addresses "
        "the task's configured goal/prompt, follows any stated instructions "
        "and constraints, and contains no unsupported or fabricated claims."
    ),
    "ToolCall": (
        "Judge whether the tool's returned result plausibly satisfies the "
        "call's intent -- not an error, empty result, or unrelated data "
        "masquerading as a successful response."
    ),
    "SandboxExec": (
        "Judge the produced code's correctness and quality relative to the "
        "task's intent: does it implement what was asked, is it free of "
        "obvious logic errors, and does it avoid placeholder/stub content. "
        "This is a semantic quality check layered on top of Sandbox "
        "Service's own deterministic build/render/placeholder gates, not a "
        "replacement for them."
    ),
    "Synthesis": (
        "Judge whether the merged output coherently incorporates every "
        "upstream result it claims to synthesize, with no unaddressed gaps "
        "or contradictions between the sources."
    ),
    # Design log §5.3: every node can pass on its own while the whole run
    # still misses what was asked. This judges the run's final outputs
    # together against the original intake criteria.
    "RunOutcome": (
        "Judge whether the run's final outputs, taken together, deliver what "
        "the user asked for: every stated success criterion is achieved by "
        "the combined result, not merely attempted by some step of it."
    ),
}


class VerificationValidationError(ValueError):
    pass


def _verdict_for(score: float, threshold: float, warn_margin: float = WARN_MARGIN) -> Verdict:
    if score >= threshold:
        return "pass"
    if score >= threshold - warn_margin:
        return "warn"
    return "fail"


def _is_structurally_complete(output_json: str) -> bool:
    try:
        parsed = json.loads(output_json)
    except json.JSONDecodeError:
        return False
    if parsed is None:
        return False
    if isinstance(parsed, dict) and len(parsed) == 0:
        return False
    return True


class VerificationKernel:
    """Core verification reviewer.

    llm_client : ReviewerLlmClient -- ADVANCED-tier reviewer (stub or real)
    """

    def __init__(
        self,
        llm_client: ReviewerLlmClient,
        policy_client: QualityThresholdPolicyClient | None = None,
    ) -> None:
        self._llm = llm_client
        self._policy_client = policy_client

    async def score_node(self, request: ScoreNodeRequest) -> ScoreNodeResponse:
        if request.node_type in DETERMINISTIC_NODE_TYPES:
            return self._score_deterministic(request)
        return await self._score_with_reviewer(request)

    def _score_deterministic(self, request: ScoreNodeRequest) -> ScoreNodeResponse:
        complete = _is_structurally_complete(request.output_json)
        score = 1.0 if complete else 0.0
        details: dict[str, object] = {
            "reason": (
                "output is a non-empty structured value"
                if complete
                else "output is empty, null, or not valid JSON"
            ),
        }
        if request.success_criteria:
            # A routing or control-flow node's output is a decision, not
            # content; its criteria are recorded, not judged by a reviewer.
            details["criteria_not_judged"] = list(request.success_criteria)
        return ScoreNodeResponse(
            verdict="pass" if complete else "fail",
            score=score,
            threshold=1.0,
            reviewer_model=REVIEWER_MODEL_DETERMINISTIC,
            details_json=json.dumps(details),
        )

    async def _score_with_reviewer(self, request: ScoreNodeRequest) -> ScoreNodeResponse:
        rubric = NODE_TYPE_RUBRICS.get(request.node_type)
        if rubric is None:
            raise VerificationValidationError(
                f"node_type {request.node_type!r} has no registered grading rubric"
            )

        # ENGINE-FIX-P3-15: anyone who can shape a node's output -- an
        # attacker via upstream injection, or a model that drifted -- can
        # otherwise shape its own verification result, because the
        # ADVANCED reviewer below is an LLM that cannot reliably
        # distinguish injected instructions from the content it's judging.
        # Classify BEFORE the output ever reaches that reviewer; a
        # detected attempt never gets reviewed at all.
        classification = await self._llm.classify_prompt_injection(
            tenant_id=request.tenant_id,
            run_id=request.run_id,
            node_execution_id=request.node_execution_id,
            text=request.output_json,
        )
        if classification.injection_detected:
            threshold, _warn_margin = await self._resolve_threshold(request.tenant_id)
            blocked = {
                "reason": classification.reason
                or "output classified as a prompt injection attempt",
                "confidence": classification.confidence,
            }
            return ScoreNodeResponse(
                verdict="fail",
                score=0.0,
                threshold=threshold,
                reviewer_model=REVIEWER_MODEL_INJECTION_BLOCKED,
                details_json=json.dumps(blocked),
            )

        review_config_json = request.config_json
        if request.success_criteria:
            config = json.loads(request.config_json or "{}")
            if not isinstance(config, dict):
                raise VerificationValidationError("config_json must contain an object")
            review_config_json = json.dumps(
                {**config, "success_criteria": request.success_criteria}
            )

        score, rationale = await self._llm.review(
            tenant_id=request.tenant_id,
            run_id=request.run_id,
            node_execution_id=request.node_execution_id,
            node_type=request.node_type,
            rubric=rubric,
            config_json=review_config_json,
            output_json=request.output_json,
        )
        if not 0.0 <= score <= 1.0:
            raise VerificationValidationError(
                f"reviewer returned score {score!r} outside the [0.0, 1.0] range"
            )

        threshold, warn_margin = await self._resolve_threshold(request.tenant_id)
        details: dict[str, object] = {"rationale": rationale, "rubric": rubric}
        verdict = _verdict_for(score, threshold, warn_margin)
        if request.success_criteria:
            # C29: the task's own contract. The rubric says what good output of
            # this node type looks like; the criteria say what this node was
            # asked to achieve. Any unmet criterion fails the node, whatever
            # the rubric score -- fluent, off-contract output is the failure
            # this exists to catch.
            judgements = await self._llm.judge_criteria(
                tenant_id=request.tenant_id,
                run_id=request.run_id,
                node_execution_id=request.node_execution_id,
                node_type=request.node_type,
                criteria=request.success_criteria,
                config_json=request.config_json,
                output_json=request.output_json,
            )
            _require_one_judgement_each(request.success_criteria, judgements)
            details["criteria"] = [judgement.model_dump() for judgement in judgements]
            if any(not judgement.met for judgement in judgements):
                verdict = "fail"
                details["reason"] = "output does not meet every success criterion"
        return ScoreNodeResponse(
            verdict=verdict,
            score=score,
            threshold=threshold,
            reviewer_model=MODEL_ALIAS_ADVANCED,
            details_json=json.dumps(details),
        )

    async def _resolve_threshold(self, tenant_id: str) -> tuple[float, float]:
        if self._policy_client is None:
            return DEFAULT_THRESHOLD, WARN_MARGIN
        try:
            resolved = await self._policy_client.quality_threshold(tenant_id)
        except Exception:
            return DEFAULT_THRESHOLD, WARN_MARGIN
        return resolved if resolved is not None else (DEFAULT_THRESHOLD, WARN_MARGIN)


def _require_one_judgement_each(
    criteria: tuple[str, ...], judgements: list[CriterionJudgement]
) -> None:
    """A reviewer that skips, reorders or invents a criterion has not judged
    the contract; that is an error, never a pass."""
    if [judgement.criterion for judgement in judgements] != list(criteria):
        raise VerificationValidationError(
            "reviewer did not return exactly one judgement per success criterion, in order"
        )
