"""Unit tests for PlannerKernel: decompose, replan, select_strategy."""

import json

import pytest
from pydantic import ValidationError

from src.ads_client.client import StubAdsClient
from src.ads_client.models import RetrieveRequest, RetrieveResponse
from src.planner.kernel import PlannerKernel, PlannerValidationError
from src.planner.llm_client import StubLlmClient
from src.planner.manager_worker import ManagerWorkerPlan
from src.planner.models import (
    DecomposeRequest,
    ReplanRequest,
    SelectStrategyRequest,
)
from src.planner.strategies import (
    STRATEGY_DIRECT,
    STRATEGY_ITERATIVE,
    STRATEGY_MANAGER_WORKER,
    STRATEGY_PLAN_THEN_EXECUTE,
)
from src.planner.task_skeleton import TaskNode, TaskSkeleton
from src.problem_understanding.models import ProblemSpec, problem_spec_json

TENANT_ID = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab"
WORKSPACE_ID = "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890ab"
RUN_ID = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890ab"


def _kernel() -> PlannerKernel:
    return PlannerKernel(ads_client=StubAdsClient(), llm_client=StubLlmClient())


def _decompose_req(**overrides: object) -> DecomposeRequest:
    defaults: dict[str, object] = {
        "tenant_id": TENANT_ID,
        "workspace_id": WORKSPACE_ID,
        "run_id": RUN_ID,
        "problem_spec_json": problem_spec_json(ProblemSpec(
            objective="summarise customer feedback"
        )),
        "strategy": STRATEGY_ITERATIVE,
    }
    defaults.update(overrides)
    return DecomposeRequest(**defaults)  # type: ignore[arg-type]


def _replan_req(**overrides: object) -> ReplanRequest:
    stub_skeleton = TaskSkeleton(
        version="1",
        nodes=[],
        entry_point="node_stub_000",
    )
    # nodes is empty but entry_point is enough for validation test.
    defaults: dict[str, object] = {
        "tenant_id": TENANT_ID,
        "run_id": RUN_ID,
        "current_dag_json": stub_skeleton.to_json(),
        "failure_context_json": json.dumps({"error": "timeout", "node": "node_stub_000"}),
    }
    defaults.update(overrides)
    return ReplanRequest(**defaults)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Decompose
# ---------------------------------------------------------------------------


class TestDecompose:
    async def test_returns_valid_task_skeleton_json(self) -> None:
        kernel = _kernel()
        response = await kernel.decompose(_decompose_req())

        skeleton = TaskSkeleton.from_json(response.task_skeleton_json)
        assert skeleton.version == "1"
        assert len(skeleton.nodes) >= 1
        assert skeleton.entry_point
        assert all(node.success_criteria is None for node in skeleton.nodes)

    async def test_carries_problem_spec_success_criteria_to_every_node(self) -> None:
        criteria = ["Customer feedback is grouped by theme."]
        response = await _kernel().decompose(_decompose_req(
            problem_spec_json=problem_spec_json(ProblemSpec(
                objective="summarise customer feedback",
                success_criteria=criteria,
            ))
        ))

        skeleton = TaskSkeleton.from_json(response.task_skeleton_json)
        assert all(node.success_criteria == criteria for node in skeleton.nodes)

    async def test_keeps_explicit_criterion_assignments_per_node(self) -> None:
        criteria = ["Research is complete.", "Summary is complete."]

        class ExplicitAssignmentLlm(StubLlmClient):
            async def generate_skeleton(self, **kwargs: object) -> TaskSkeleton:
                return TaskSkeleton(
                    nodes=[
                        TaskNode(
                            key="research",
                            type="llm",
                            success_criteria=[criteria[0]],
                        ),
                        TaskNode(
                            key="summary",
                            type="llm",
                            depends_on=["research"],
                            success_criteria=[criteria[1]],
                        ),
                    ],
                    entry_point="research",
                )

        response = await PlannerKernel(
            ads_client=StubAdsClient(), llm_client=ExplicitAssignmentLlm()
        ).decompose(_decompose_req(
            problem_spec_json=problem_spec_json(ProblemSpec(
                objective="research and summarise",
                success_criteria=criteria,
            ))
        ))

        skeleton = TaskSkeleton.from_json(response.task_skeleton_json)
        assert [node.success_criteria for node in skeleton.nodes] == [[criteria[0]], [criteria[1]]]
        assert skeleton.success_criteria == criteria

    async def test_rejects_an_intake_criterion_with_no_node_assignment(self) -> None:
        criteria = ["Research is complete.", "Summary is complete."]

        class IncompleteAssignmentLlm(StubLlmClient):
            async def generate_skeleton(self, **kwargs: object) -> TaskSkeleton:
                return TaskSkeleton(
                    nodes=[TaskNode(key="research", type="llm", success_criteria=[criteria[0]])],
                    entry_point="research",
                )

        kernel = PlannerKernel(ads_client=StubAdsClient(), llm_client=IncompleteAssignmentLlm())
        result = await kernel.decompose(_decompose_req(
            problem_spec_json=problem_spec_json(ProblemSpec(
                objective="research and summarise",
                success_criteria=criteria,
            ))
        ))
        assert result.ambiguity_detected
        assert "Summary is complete" in result.clarification_questions[0]
        assert "Could you clarify" in result.clarification_questions[0]

    async def test_ambiguity_false_for_short_objective_with_no_kb(self) -> None:
        kernel = _kernel()
        # Short objective (≤ 10 words) → no ambiguity even with empty KB.
        response = await kernel.decompose(_decompose_req())

        assert response.ambiguity_detected is False
        assert response.clarification_questions == []

    async def test_ambiguity_true_for_long_objective_with_empty_kb(self) -> None:
        kernel = _kernel()
        # > 10 words + StubAdsClient always returns empty hits → ambiguity
        response = await kernel.decompose(_decompose_req(
            problem_spec_json=problem_spec_json(ProblemSpec(
                objective="run report", missing_information=["the report period"]
            ))
        ))

        assert response.ambiguity_detected is True
        assert len(response.clarification_questions) >= 1

    async def test_rejects_malformed_tenant_id(self) -> None:
        with pytest.raises(ValidationError):
            _decompose_req(tenant_id="not-a-tenant")

    async def test_rejects_blank_objective(self) -> None:
        with pytest.raises(ValidationError):
            _decompose_req(problem_spec_json="   ")

    async def test_rejects_malformed_run_id(self) -> None:
        with pytest.raises(ValidationError):
            _decompose_req(run_id="bad_id")


class TestDecomposeProjectStrategy:
    async def test_plan_then_execute_produces_fourteen_stage_pipeline(self) -> None:
        kernel = _kernel()
        response = await kernel.decompose(
            _decompose_req(
                problem_spec_json=problem_spec_json(ProblemSpec(
                    objective="build a support ticket app"
                )),
                strategy=STRATEGY_PLAN_THEN_EXECUTE,
            )
        )

        skeleton = TaskSkeleton.from_json(response.task_skeleton_json)
        assert len(skeleton.nodes) == 14
        assert skeleton.entry_point == "node_clarify_objective"

    async def test_plan_then_execute_never_calls_llm_client(self) -> None:
        class ExplodingLlmClient(StubLlmClient):
            async def generate_skeleton(self, **kwargs: object) -> TaskSkeleton:
                raise AssertionError("Project strategy must not call generate_skeleton")

        kernel = PlannerKernel(ads_client=StubAdsClient(), llm_client=ExplodingLlmClient())
        response = await kernel.decompose(
            _decompose_req(
                problem_spec_json=problem_spec_json(ProblemSpec(objective="build an app")),
                strategy=STRATEGY_PLAN_THEN_EXECUTE,
            )
        )

        assert TaskSkeleton.from_json(response.task_skeleton_json).nodes


class TestDecomposeManagerWorkerStrategy:
    async def test_manager_worker_produces_manager_plus_workers_plus_join(self) -> None:
        kernel = _kernel()
        response = await kernel.decompose(
            _decompose_req(
                problem_spec_json=problem_spec_json(ProblemSpec(
                    objective="coordinate multiple regional teams"
                )),
                strategy=STRATEGY_MANAGER_WORKER,
            )
        )

        skeleton = TaskSkeleton.from_json(response.task_skeleton_json)
        assert skeleton.entry_point == "node_manager"
        node_keys = {n.key for n in skeleton.nodes}
        assert "node_manager" in node_keys
        assert "node_join" in node_keys
        assert len(node_keys) >= 3  # manager + >=1 worker + join

    async def test_manager_worker_requests_ceiling_tier(self) -> None:
        captured: dict[str, object] = {}

        class CapturingLlmClient(StubLlmClient):
            async def generate_manager_worker_plan(
                self,
                *,
                tenant_id: str,
                run_id: str,
                objective: str,
                kb_context: str,
                model_alias: str,
            ) -> ManagerWorkerPlan:
                captured["model_alias"] = model_alias
                return await super().generate_manager_worker_plan(
                    tenant_id=tenant_id,
                    run_id=run_id,
                    objective=objective,
                    kb_context=kb_context,
                    model_alias=model_alias,
                )

        kernel = PlannerKernel(ads_client=StubAdsClient(), llm_client=CapturingLlmClient())
        await kernel.decompose(
            _decompose_req(
                problem_spec_json=problem_spec_json(ProblemSpec(
                    objective="coordinate multiple teams"
                )),
                strategy=STRATEGY_MANAGER_WORKER,
            )
        )

        assert captured["model_alias"] == "CEILING"

    async def test_decompose_never_retrieves_ads_context(self) -> None:
        class ExplodingAdsClient(StubAdsClient):
            async def retrieve(self, request: RetrieveRequest) -> RetrieveResponse:
                del request
                raise AssertionError("Planner decompose must not retrieve ADS context")

        kernel = PlannerKernel(ads_client=ExplodingAdsClient(), llm_client=StubLlmClient())
        response = await kernel.decompose(_decompose_req())

        assert TaskSkeleton.from_json(response.task_skeleton_json).nodes


# ---------------------------------------------------------------------------
# Replan
# ---------------------------------------------------------------------------


class TestReplan:
    async def test_returns_revised_skeleton_and_reason(self) -> None:
        kernel = _kernel()
        response = await kernel.replan(_replan_req())

        skeleton = TaskSkeleton.from_json(response.revised_skeleton_json)
        assert skeleton.version == "1"
        assert response.reason

    async def test_preserves_node_structure_in_stub(self) -> None:
        from src.planner.task_skeleton import TaskNode

        original = TaskSkeleton(
            version="1",
            nodes=[TaskNode(key="node_a", type="llm", config={}, depends_on=[])],
            entry_point="node_a",
        )
        kernel = _kernel()
        response = await kernel.replan(
            _replan_req(current_dag_json=original.to_json())
        )

        revised = TaskSkeleton.from_json(response.revised_skeleton_json)
        assert revised.entry_point == "node_a"

    async def test_raises_validation_error_on_invalid_dag_json(self) -> None:
        kernel = _kernel()
        with pytest.raises(PlannerValidationError, match="current_dag_json"):
            await kernel.replan(_replan_req(current_dag_json='{"broken": true}'))

    async def test_raises_validation_error_on_invalid_failure_context_json(self) -> None:
        kernel = _kernel()
        with pytest.raises(PlannerValidationError, match="failure_context_json"):
            await kernel.replan(_replan_req(failure_context_json="not json {{"))

    async def test_rejects_malformed_tenant_id(self) -> None:
        with pytest.raises(ValidationError):
            _replan_req(tenant_id="bad")


# ---------------------------------------------------------------------------
# SelectStrategy
# ---------------------------------------------------------------------------


class TestSelectStrategy:
    async def test_project_mode_returns_plan_then_execute(self) -> None:
        kernel = _kernel()
        response = await kernel.select_strategy(
            SelectStrategyRequest(
                tenant_id=TENANT_ID,
                objective="build a new product",
                mode="project",
            )
        )

        assert response.strategy == STRATEGY_PLAN_THEN_EXECUTE
        assert response.reason

    async def test_workflow_simple_returns_direct(self) -> None:
        kernel = _kernel()
        response = await kernel.select_strategy(
            SelectStrategyRequest(
                tenant_id=TENANT_ID,
                objective="run test",
                mode="workflow",
            )
        )

        assert response.strategy == STRATEGY_DIRECT

    async def test_workflow_complex_returns_iterative(self) -> None:
        kernel = _kernel()
        response = await kernel.select_strategy(
            SelectStrategyRequest(
                tenant_id=TENANT_ID,
                objective="generate a detailed monthly report",
                mode="workflow",
            )
        )

        assert response.strategy == STRATEGY_ITERATIVE

    async def test_unknown_mode_returns_iterative(self) -> None:
        kernel = _kernel()
        response = await kernel.select_strategy(
            SelectStrategyRequest(
                tenant_id=TENANT_ID,
                objective="do something",
                mode="banana",
            )
        )

        assert response.strategy == STRATEGY_ITERATIVE

    async def test_rejects_blank_objective(self) -> None:
        with pytest.raises(ValidationError):
            SelectStrategyRequest(tenant_id=TENANT_ID, objective="", mode="workflow")

    async def test_rejects_malformed_tenant_id(self) -> None:
        with pytest.raises(ValidationError):
            SelectStrategyRequest(
                tenant_id="bad",
                objective="do something",
                mode="workflow",
            )


class _ClassifyingLlm(StubLlmClient):
    def __init__(self, answer: tuple[str, str] | Exception) -> None:
        self.answer = answer
        self.calls: list[dict[str, str]] = []

    async def classify_workflow_strategy(
        self, *, tenant_id: str, run_id: str, objective: str
    ) -> tuple[str, str]:
        self.calls.append({"tenant_id": tenant_id, "run_id": run_id, "objective": objective})
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


class TestSelectStrategyModelBacked:
    async def test_workflow_uses_the_model_choice_over_the_keyword_heuristic(self) -> None:
        # The heuristic calls a comma-free objective "direct"; the model's
        # answer must win.
        llm = _ClassifyingLlm((STRATEGY_MANAGER_WORKER, "Independent workstreams."))
        kernel = PlannerKernel(ads_client=StubAdsClient(), llm_client=llm)

        response = await kernel.select_strategy(
            SelectStrategyRequest(
                tenant_id=TENANT_ID,
                run_id=RUN_ID,
                objective="Localize the app into four languages",
                mode="workflow",
            )
        )

        assert response.strategy == STRATEGY_MANAGER_WORKER
        assert response.reason == "Independent workstreams."
        assert llm.calls == [
            {
                "tenant_id": TENANT_ID,
                "run_id": RUN_ID,
                "objective": "Localize the app into four languages",
            }
        ]

    async def test_workflow_falls_back_to_the_heuristic_when_the_model_fails(self) -> None:
        llm = _ClassifyingLlm(ValueError("model chose unknown workflow strategy 'x'"))
        kernel = PlannerKernel(ads_client=StubAdsClient(), llm_client=llm)

        response = await kernel.select_strategy(
            SelectStrategyRequest(tenant_id=TENANT_ID, objective="run test", mode="workflow")
        )

        assert response.strategy == STRATEGY_DIRECT
        assert response.reason.endswith("(keyword fallback: model classification failed)")

    @pytest.mark.parametrize("mode", ["project", "banana"])
    async def test_non_workflow_modes_never_ask_the_model(self, mode: str) -> None:
        llm = _ClassifyingLlm(AssertionError("must not be called"))
        kernel = PlannerKernel(ads_client=StubAdsClient(), llm_client=llm)

        response = await kernel.select_strategy(
            SelectStrategyRequest(tenant_id=TENANT_ID, objective="do something", mode=mode)
        )

        assert llm.calls == []
        assert response.strategy in {STRATEGY_PLAN_THEN_EXECUTE, STRATEGY_ITERATIVE}
        assert "fallback" not in response.reason

    async def test_rejects_malformed_run_id(self) -> None:
        with pytest.raises(ValidationError):
            SelectStrategyRequest(
                tenant_id=TENANT_ID, run_id="bad", objective="do something", mode="workflow"
            )
