"""D8 rule-derived cases: edited intake is authoritative; incomplete plans ask."""

import json

import pytest

from src.ads_client.client import StubAdsClient
from src.planner.kernel import PlannerKernel
from src.planner.llm_client import StubLlmClient
from src.planner.models import DecomposeRequest
from src.planner.task_skeleton import TaskNode, TaskSkeleton
from src.problem_understanding.models import ProblemSpec, problem_spec_json


@pytest.mark.parametrize(
    ("criteria", "assigned", "asks"),
    [
        (["Send a weekly digest."], ["Send a weekly digest."], False),
        (["Notify the support team."], ["Notify the support team."], False),
        ([], [], False),
        (["Notify support.", "Archive the invoice."], ["Notify support."], True),
        (["Notify support."], ["Notify support.", "Old inferred goal."], True),
    ],
    ids=["edited", "removed", "all-removed", "uncovered-added", "stale-inference"],
)
async def test_confirmed_criteria_are_assigned_or_asked(
    criteria: list[str], assigned: list[str], asks: bool
) -> None:
    class AssignmentEdge(StubLlmClient):
        async def generate_skeleton(self, **kwargs: object) -> TaskSkeleton:
            spec = json.loads(str(kwargs["problem_spec_json"]))
            assert spec.get("success_criteria", []) == criteria
            return TaskSkeleton(
                nodes=[TaskNode(key="work", type="llm", success_criteria=assigned or None)],
                entry_point="work",
            )

    result = await PlannerKernel(StubAdsClient(), AssignmentEdge()).decompose(
        DecomposeRequest(
            tenant_id="ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
            workspace_id="ws_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
            run_id="run_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
            strategy="default",
            problem_spec_json=problem_spec_json(
                ProblemSpec(objective="Triage support mail", success_criteria=criteria)
            ),
        )
    )
    assert result.ambiguity_detected is asks
    if asks:
        assert result.clarification_questions
        assert "Could you" in result.clarification_questions[0]
        assert any(c in result.clarification_questions[0] for c in set(criteria + assigned))
    else:
        skeleton = TaskSkeleton.from_json(result.task_skeleton_json)
        assert skeleton.success_criteria == (criteria or None)
        assert skeleton.nodes[0].success_criteria == (assigned or None)
